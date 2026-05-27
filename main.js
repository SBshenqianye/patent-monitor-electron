const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const EventEmitter = require('events');

let mainWindow = null;
let userDataDir = null;
let dataDir = null;
let scriptsDir = null;

const childProcesses = new Map();
const loginQueue = [];
let isLoginInProgress = false;
const LOGIN_TIMEOUT = 5 * 60 * 1000; // 5分钟
const CRAWLER_TIMEOUT = 5 * 60 * 1000; // 爬虫执行超时 5 分钟
const loginEvents = new EventEmitter();

// ============================================================
function initPaths() {
    userDataDir = app.getPath('userData');
    dataDir = path.join(userDataDir, 'data');
    if (app.isPackaged) {
        scriptsDir = path.join(process.resourcesPath, 'patent_crawlers');
    } else {
        scriptsDir = path.join(__dirname, 'patent_crawlers');
    }
    fs.mkdirSync(dataDir, { recursive: true });
    console.log('[main] userDataDir:', userDataDir);
    console.log('[main] dataDir:', dataDir);
    console.log('[main] scriptsDir:', scriptsDir);
}

function getScriptPath(scriptName) {
    const pyPath = path.join(scriptsDir, scriptName);
    const exePath = pyPath.replace(/\.py$/, '.exe');
    if (fs.existsSync(exePath)) return exePath;
    if (fs.existsSync(pyPath)) return pyPath;
    return pyPath;
}

function runPythonScript(scriptPath, args = []) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(scriptPath)) {
            reject(new Error(`脚本不存在: ${scriptPath}`));
            return;
        }

        const isExe = scriptPath.endsWith('.exe');
        const cmd = isExe ? scriptPath : 'python';
        const cmdArgs = isExe ? args : [scriptPath, ...args];

        console.log(`[spawn] ${cmd} ${cmdArgs.join(' ')}`);

        const proc = spawn(cmd, cmdArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf-8',
            cwd: path.dirname(scriptPath),
        });

        const procId = `${Date.now()}_${Math.random()}`;
        childProcesses.set(procId, proc);

        let stdout = '';
        let stderr = '';
        let killed = false;

        // 超时定时器
        const timer = setTimeout(() => {
            killed = true;
            proc.kill('SIGTERM');
            // 若 5 秒后仍未退出，强制杀死
            setTimeout(() => {
                if (proc.exitCode === null) proc.kill('SIGKILL');
            }, 5000);
        }, CRAWLER_TIMEOUT);

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
            console.log(`[stdout] ${data}`);
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
            console.log(`[stderr] ${data}`);
        });

        proc.on('close', (code) => {
            clearTimeout(timer);
            childProcesses.delete(procId);
            console.log(`[exit] code=${code}`);
            if (killed) {
                reject(new Error(`爬虫执行超时 (${CRAWLER_TIMEOUT/1000}秒)`));
            } else if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`进程退出码 ${code}: ${stderr || stdout}`));
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            childProcesses.delete(procId);
            reject(err);
        });
    });
}

// 检查指定爬虫的登录状态（通过执行 python script --action check）
async function checkLoginStatus(name, scriptName) {
    const scriptPath = getScriptPath(scriptName);
    if (!fs.existsSync(scriptPath)) {
        console.error(`[checkLogin] 脚本不存在: ${scriptPath}`);
        return false;
    }
    try {
        const result = await runPythonScript(scriptPath, ['--data-dir', dataDir, '--action', 'check']);
        // 解析 stdout 最后一行 JSON（注意日志干扰，假设 JSON 在最后一行）
        const lines = result.stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1].trim();
        if (lastLine.startsWith('{')) {
            const data = JSON.parse(lastLine);
            return data.loggedIn === true;
        }
    } catch (err) {
        console.error(`[checkLogin] 执行 check 失败:`, err.message);
    }
    return false;
}

function sendToRenderer(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

// ================ 登录队列 ================
function requestLogin(name) {
    return new Promise((resolve) => {
        loginQueue.push({ name, resolve });
        processLoginQueue();
    });
}

function processLoginQueue() {
    if (isLoginInProgress || loginQueue.length === 0) return;

    const { name, resolve } = loginQueue.shift();
    isLoginInProgress = true;

    const timer = setTimeout(() => {
        if (isLoginInProgress) {
            isLoginInProgress = false;
            resolve();
            sendToRenderer('login-timeout', { name });
            processLoginQueue();
        }
    }, LOGIN_TIMEOUT);

    const handler = (eventName) => {
        clearTimeout(timer);
        loginEvents.removeAllListeners(`login-done-${name}`);
        loginEvents.removeAllListeners(`login-cancel-${name}`);
        isLoginInProgress = false;
        resolve();
        processLoginQueue();
    };

    loginEvents.once(`login-done-${name}`, () => handler('login-done'));
    loginEvents.once(`login-cancel-${name}`, () => handler('login-cancel'));

    sendToRenderer('login-required', {
        name,
        needLogin: true,
        message: `"${name}" 需要登录，请点击「开始登录」完成浏览器登录`
    });
}

// ================ 检查爬虫输出文件 ================
function hasNewFilesInDataDir(startTime) {
    function scanDir(dir, depth = 0) {
        if (depth > 2) return false; // 只检查两层子目录
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (scanDir(fullPath, depth + 1)) return true;
                } else if (entry.isFile()) {
                    const stat = fs.statSync(fullPath);
                    if (stat.mtimeMs > startTime) {
                        console.log(`[文件检查] 发现新文件: ${fullPath}`);
                        return true;
                    }
                }
            }
        } catch (e) {
            // 忽略权限错误等
        }
        return false;
    }
    return scanDir(dataDir);
}

// ================ 爬虫执行 ================
async function runCrawler(name, scriptName, requiresLogin) {
    const scriptPath = getScriptPath(scriptName);

    if (!fs.existsSync(scriptPath)) {
        sendToRenderer('crawler-status', { name, status: 'error', message: `${name} 失败: 脚本不存在: ${scriptPath}` });
        return { success: false, error: `脚本不存在: ${scriptPath}` };
    }

    // 需要登录的爬虫：先检查登录状态
    if (requiresLogin) {
        sendToRenderer('crawler-status', { name, status: 'checking-login', message: `正在检查登录状态...` });
        const loggedIn = await checkLoginStatus(name, scriptName);
        if (loggedIn) {
            sendToRenderer('crawler-status', { name, status: 'login-ok', message: `${name} 已登录，继续爬取` });
        } else {
            sendToRenderer('crawler-status', { name, status: 'waiting-login', message: `正在排队等待登录...` });
            await requestLogin(name);  // 进入登录队列，等待用户完成登录
            // 登录完成后再次确认状态（可能用户登录失败了？这里简单放行，由 crawl 动作内部处理）
        }
    }

    sendToRenderer('crawler-status', { name, status: 'running', message: `正在运行 ${name}...` });

    try {
        const result = await runPythonScript(scriptPath, ['--data-dir', dataDir, '--action', 'crawl']);
        // ... 原有成功/失败处理 ...
    } catch (err) {
        // ... 错误处理 ...
    }
}

async function runAllCrawlers() {
    const crawlerScripts = [
        // { name: '爬虫A-专利公告', script: '01_专利过期监控爬虫_v2.py', requiresLogin: false },
        { name: '爬虫B-天眼查', script: '02_天眼查专利导出.py', requiresLogin: true },
        // { name: '爬虫C-CNIPA', script: '03_CNIPA专利导出.py', requiresLogin: true },
    ];

    const promises = crawlerScripts.map(c => {
        return runCrawler(c.name, c.script, c.requiresLogin);
    });

    const results = await Promise.allSettled(promises);
    const finalResults = results.map((r, i) => ({
        name: crawlerScripts[i].name,
        status: r.status === 'fulfilled' ? (r.value.success ? 'completed' : 'error') : 'error',
        message: r.status === 'fulfilled' ? (r.value.success ? '完成' : r.value.error) : '进程异常',
    }));

    sendToRenderer('crawler-status', { name: 'all', status: 'completed', message: '一键爬取完成', allDone: true });
    return finalResults;
}

async function runCleaning() {
    sendToRenderer('cleaning-status', { status: 'running', message: '正在清洗数据...' });
    try {
        const scriptPath = getScriptPath('00_数据清洗融合.py');
        if (!fs.existsSync(scriptPath)) {
            throw new Error(`脚本不存在: ${scriptPath}`);
        }
        const result = await runPythonScript(scriptPath, ['--data-dir', dataDir]);
        sendToRenderer('cleaning-status', { status: 'completed', message: '数据清洗完成' });
        return { success: true };
    } catch (err) {
        sendToRenderer('cleaning-status', { status: 'error', message: `清洗失败: ${err.message}` });
        return { success: false, error: err.message };
    }
}

function readCleanedJson() {
    const jsonPath = path.join(dataDir, "cleaned_data", '专利数据_清洗融合.json');
    if (!fs.existsSync(jsonPath)) return null;
    try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        if (Array.isArray(raw)) {
            return { patents: raw };
        }
        return raw;
    } catch {
        return null;
    }
}

function generateSampleData() {
    return {
        patents: [],
        stats: {},
        summary: {},
        timeline: [],
        pie_data: [],
        companies: []
    };
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        title: '专利监控看板',
    });
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    if (!app.isPackaged) {
        mainWindow.webContents.openDevTools();
    }
    mainWindow.on('closed', () => { mainWindow = null; });
}

function setupIPC() {
    ipcMain.handle('get-data', () => {
        const data = readCleanedJson();
        return { success: true, data: data || generateSampleData() };
    });

    ipcMain.handle('run-all-crawlers', async () => {
        const results = await runAllCrawlers();
        return { success: true, results };
    });

    ipcMain.handle('run-cleaning', async () => await runCleaning());

    ipcMain.handle('check-login', async (event, name) => ({ loggedIn: false }));

    ipcMain.handle('guide-login', async (event, name) => {
        const scriptMap = {
            '爬虫B-天眼查': '02_天眼查专利导出.py',
            '爬虫C-CNIPA': '03_CNIPA专利导出.py',
        };
        const scriptName = scriptMap[name];
        if (!scriptName) return { success: false, error: '未知爬虫' };

        const scriptPath = getScriptPath(scriptName);
        if (!fs.existsSync(scriptPath)) {
            return { success: false, error: `脚本不存在: ${scriptPath}` };
        }

        try {
            const result = await runPythonScript(scriptPath, ['--data-dir', dataDir, '--action', 'login']);
            // 解析登录结果
            const lines = result.stdout.trim().split('\n');
            const lastLine = lines[lines.length - 1].trim();
            let loginSuccess = false;
            if (lastLine.startsWith('{')) {
                const data = JSON.parse(lastLine);
                loginSuccess = data.loggedIn === true;
            }
            if (loginSuccess) {
                loginEvents.emit(`login-done-${name}`);
                sendToRenderer('login-done', { name });
            } else {
                // 登录失败也放行，避免永久阻塞（但爬虫会因未登录报错）
                loginEvents.emit(`login-cancel-${name}`);
                sendToRenderer('login-failed', { name });
            }
            return { success: loginSuccess };
        } catch (err) {
            loginEvents.emit(`login-cancel-${name}`);
            sendToRenderer('login-failed', { name });
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('cancel-login', async (event, name) => {
        loginEvents.emit(`login-cancel-${name}`);
        sendToRenderer('login-cancelled', { name });
        return { success: true };
    });

    ipcMain.handle('get-data-dir', () => dataDir);
    ipcMain.handle('get-user-data-dir', () => userDataDir);
}

app.whenReady().then(() => {
    initPaths();
    setupIPC();
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    for (const [key, proc] of childProcesses) {
        try { proc.kill('SIGTERM'); } catch (e) {}
    }
    childProcesses.clear();
});