const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow = null;
let userDataDir = null;
let dataDir = null;
let scriptsDir = null;

// 子进程管理
const childProcesses = new Map();

// ============================================================
// 路径初始化
// ============================================================
function initPaths() {
    userDataDir = app.getPath('userData');
    dataDir = path.join(userDataDir, 'data');
    // 在开发模式下，脚本在项目内的 scripts/ 目录；打包后在 extraResources/scripts/
    if (app.isPackaged) {
        scriptsDir = path.join(process.resourcesPath, 'scripts');
    } else {
        scriptsDir = path.join(__dirname, 'scripts');
    }
    fs.mkdirSync(dataDir, { recursive: true });
    console.log('[main] userDataDir:', userDataDir);
    console.log('[main] dataDir:', dataDir);
    console.log('[main] scriptsDir:', scriptsDir);
}

// ============================================================
// 辅助：查找爬虫输出文件
// ============================================================
function findOutputFile(dir, patterns) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir);
    for (const pattern of patterns) {
        const match = files.find(f => f.includes(pattern) && !f.endsWith('.log'));
        if (match) return path.join(dir, match);
    }
    return null;
}

// ============================================================
// 执行 Python 脚本
// ============================================================
function runPythonScript(scriptPath, args = []) {
    return new Promise((resolve, reject) => {
        // 检查 exe 版本是否存在
        const exePath = scriptPath.replace(/\.py$/, '.exe');
        const finalScript = fs.existsSync(exePath) ? exePath : scriptPath;
        const isExe = finalScript.endsWith('.exe');

        if (!fs.existsSync(finalScript) && !isExe) {
            reject(new Error(`脚本不存在: ${finalScript}`));
            return;
        }

        const cmd = isExe ? finalScript : 'python';
        const cmdArgs = isExe ? args : [finalScript, ...args];

        console.log(`[spawn] ${cmd} ${cmdArgs.join(' ')}`);

        const proc = spawn(cmd, cmdArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf-8',
            cwd: path.dirname(finalScript),
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
            console.log(`[stdout] ${data}`);
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
            console.log(`[stderr] ${data}`);
        });

        proc.on('close', (code) => {
            console.log(`[exit] code=${code}`);
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`进程退出码 ${code}: ${stderr || stdout}`));
            }
        });

        proc.on('error', (err) => {
            reject(err);
        });
    });
}

// ============================================================
// 登录检查与引导
// ============================================================
function getBrowserContextPath(name) {
    return path.join(userDataDir, `browser-context-${name}`);
}

async function checkLogin(name, scriptPath) {
    const contextPath = getBrowserContextPath(name);
    const isLoggedIn = fs.existsSync(path.join(contextPath, 'Default'));

    if (isLoggedIn) {
        console.log(`[${name}] 已有登录会话，跳过登录`);
        return { needLogin: false };
    }

    // 弹出可见浏览器让用户登录
    return new Promise((resolve, reject) => {
        console.log(`[${name}] 需要登录，启动浏览器...`);

        const exePath = scriptPath.replace(/\.py$/, '.exe');
        const finalScript = fs.existsSync(exePath) ? exePath : scriptPath;
        const isExe = finalScript.endsWith('.exe');

        const cmd = isExe ? finalScript : 'python';
        const cmdArgs = isExe
            ? ['check', contextPath, dataDir]
            : [finalScript, 'check', contextPath, dataDir];

        const proc = spawn(cmd, cmdArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf-8',
            cwd: path.dirname(finalScript),
        });

        let output = '';
        proc.stdout.on('data', (d) => { output += d.toString(); console.log(`[${name}] ${d}`); });
        proc.stderr.on('data', (d) => { output += d.toString(); console.log(`[${name}] ${d}`); });

        proc.on('close', (code) => {
            // 无论退出码如何，用户可能已经登录或关闭了窗口
            const hasSession = fs.existsSync(path.join(contextPath, 'Default'));
            resolve({ needLogin: !hasSession, output, contextPath });
        });

        proc.on('error', reject);
    });
}

// ============================================================
// 通知渲染进程
// ============================================================
function sendToRenderer(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

// ============================================================
// 爬虫执行逻辑
// ============================================================
async function runCrawler(name, scriptPath, requiresLogin) {
    const contextPath = getBrowserContextPath(name);

    // 检查并引导登录
    if (requiresLogin) {
        const hasSession = fs.existsSync(path.join(contextPath, 'Default'));
        if (!hasSession) {
            sendToRenderer('login-required', { name, needLogin: true });
            // 等待用户确认登录
            // 这里通过 IPC 等待渲染进程确认
            await new Promise((resolve) => {
                ipcMain.once(`login-done-${name}`, () => resolve());
            });
        }
    }

    sendToRenderer('crawler-status', { name, status: 'running', message: `正在运行 ${name}...` });

    try {
        const exePath = scriptPath.replace(/\.py$/, '.exe');
        const finalScript = fs.existsSync(exePath) ? exePath : scriptPath;
        const isExe = finalScript.endsWith('.exe');

        const cmd = isExe ? finalScript : 'python';
        const cmdArgs = isExe
            ? ['crawl', contextPath, dataDir]
            : [finalScript, 'crawl', contextPath, dataDir];

        const result = await runPythonScript(scriptPath, ['crawl', contextPath, dataDir]);
        sendToRenderer('crawler-status', { name, status: 'completed', message: `${name} 完成` });
        return { success: true, output: result.stdout };
    } catch (err) {
        sendToRenderer('crawler-status', { name, status: 'error', message: `${name} 失败: ${err.message}` });
        return { success: false, error: err.message };
    }
}

// ============================================================
// 一键爬取（并发执行）
// ============================================================
async function runAllCrawlers() {
    const crawlerScripts = [
        { name: '爬虫A-专利公告', script: '01_专利过期监控爬虫_v2.py', requiresLogin: false },
        { name: '爬虫B-CNIPA', script: '02_CNIPA专利导出.py', requiresLogin: true },
        { name: '爬虫C-天眼查', script: '03_天眼查专利导出.py', requiresLogin: true },
    ];

    const promises = crawlerScripts.map(c => {
        const scriptPath = path.join(scriptsDir, c.script);
        return runCrawler(c.name, scriptPath, c.requiresLogin);
    });

    const results = await Promise.allSettled(promises);
    return results.map((r, i) => ({
        name: crawlerScripts[i].name,
        status: r.status === 'fulfilled' ? (r.value.success ? 'completed' : 'error') : 'error',
        message: r.status === 'fulfilled' ? (r.value.success ? '完成' : r.value.error) : '进程异常',
    }));
}

// ============================================================
// 一键清洗
// ============================================================
async function runCleaning() {
    sendToRenderer('cleaning-status', { status: 'running', message: '正在清洗数据...' });
    try {
        const scriptPath = path.join(scriptsDir, '04_数据清洗融合.py');
        const result = await runPythonScript(scriptPath, [dataDir]);
        sendToRenderer('cleaning-status', { status: 'completed', message: '数据清洗完成' });
        return { success: true };
    } catch (err) {
        sendToRenderer('cleaning-status', { status: 'error', message: `清洗失败: ${err.message}` });
        return { success: false, error: err.message };
    }
}

// ============================================================
// 读取最终 JSON
// ============================================================
function readCleanedJson() {
    const jsonPath = path.join(dataDir, 'cleaned_data.json');
    if (!fs.existsSync(jsonPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    } catch {
        return null;
    }
}

// ============================================================
// 创建主窗口
// ============================================================
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

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ============================================================
// IPC 处理
// ============================================================
function setupIPC() {
    // 读取清洁后的 JSON 数据
    ipcMain.handle('get-data', () => {
        const data = readCleanedJson();
        return data ? { success: true, data } : { success: false, error: '暂无数据，请先运行数据清洗' };
    });

    // 一键爬取
    ipcMain.handle('run-all-crawlers', async () => {
        const results = await runAllCrawlers();
        return { success: true, results };
    });

    // 一键清洗
    ipcMain.handle('run-cleaning', async () => {
        return await runCleaning();
    });

    // 检查登录状态
    ipcMain.handle('check-login', async (event, name) => {
        const contextPath = getBrowserContextPath(name);
        const hasSession = fs.existsSync(path.join(contextPath, 'Default'));
        return { needLogin: !hasSession };
    });

    // 引导登录
    ipcMain.handle('guide-login', async (event, name) => {
        const scriptMap = {
            '爬虫B-CNIPA': '02_CNIPA专利导出.py',
            '爬虫C-天眼查': '03_天眼查专利导出.py',
        };
        const scriptName = scriptMap[name];
        if (!scriptName) return { success: false, error: '未知爬虫' };

        const scriptPath = path.join(scriptsDir, scriptName);
        const contextPath = getBrowserContextPath(name);

        try {
            const exePath = scriptPath.replace(/\.py$/, '.exe');
            const finalScript = fs.existsSync(exePath) ? exePath : scriptPath;
            const isExe = finalScript.endsWith('.exe');

            const cmd = isExe ? finalScript : 'python';
            const cmdArgs = isExe ? ['login', contextPath, dataDir] : [finalScript, 'login', contextPath, dataDir];

            const proc = spawn(cmd, cmdArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
                encoding: 'utf-8',
                cwd: path.dirname(finalScript),
            });

            proc.stdout.on('data', (d) => console.log(`[login-${name}] ${d}`));
            proc.stderr.on('data', (d) => console.log(`[login-${name}] ${d}`));

            await new Promise((resolve, reject) => {
                proc.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`登录进程退出码 ${code}`));
                });
                proc.on('error', reject);
            });

            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // 获取数据目录
    ipcMain.handle('get-data-dir', () => {
        return dataDir;
    });

    // 获取用户数据目录
    ipcMain.handle('get-user-data-dir', () => {
        return userDataDir;
    });
}

// ============================================================
// 应用生命周期
// ============================================================
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