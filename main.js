const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow = null;
let userDataDir = null;
let dataDir = null;
let scriptsDir = null;

const childProcesses = new Map();
const CRAWLER_TIMEOUT = 5 * 60 * 1000;    // 5 分钟

// 登录互斥锁：同一时间只允许一个需要登录的爬虫运行
let loginSlotBusy = false;
const loginWaitQueue = [];

function acquireLoginSlot(name) {
    console.log(`[login-slot] 爬虫 "${name}" 请求登录槽，当前繁忙: ${loginSlotBusy}`);
    return new Promise(resolve => {
        if (!loginSlotBusy) {
            loginSlotBusy = true;
            console.log(`[login-slot] 爬虫 "${name}" 获得登录槽`);
            resolve();
        } else {
            console.log(`[login-slot] 爬虫 "${name}" 进入等待队列`);
            loginWaitQueue.push({ name, resolve });
        }
    });
}

function releaseLoginSlot(name) {
    console.log(`[login-slot] 爬虫 "${name}" 释放登录槽`);
    if (loginWaitQueue.length > 0) {
        const next = loginWaitQueue.shift();
        console.log(`[login-slot] 唤醒队列中的爬虫 "${next.name}"`);
        next.resolve();
    } else {
        loginSlotBusy = false;
        console.log(`[login-slot] 队列为空，登录槽释放`);
    }
}

// ========== 路径初始化 ==========
function initPaths() {
    userDataDir = app.getPath('userData');
    dataDir = path.join(userDataDir, 'data');
    scriptsDir = app.isPackaged
        ? path.join(process.resourcesPath, 'patent_crawlers')
        : path.join(__dirname, 'patent_crawlers');
    fs.mkdirSync(dataDir, { recursive: true });
}

function getScriptPath(scriptName) {
    const pyPath = path.join(scriptsDir, scriptName);
    const exePath = pyPath.replace(/\.py$/, '.exe');
    return fs.existsSync(exePath) ? exePath : pyPath;
}

// ========== Python 进程执行（带超时） ==========
function runPythonScript(scriptPath, args = []) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(scriptPath)) {
            return reject(new Error(`脚本不存在: ${scriptPath}`));
        }
        const isExe = scriptPath.endsWith('.exe');
        const cmd = isExe ? scriptPath : 'python';
        const cmdArgs = isExe ? args : [scriptPath, ...args];
        console.log(`[spawn] ${cmd} ${cmdArgs.join(' ')}`);

        const proc = spawn(cmd, cmdArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: path.dirname(scriptPath),
        });
        const procId = `${Date.now()}_${Math.random()}`;
        childProcesses.set(procId, proc);

        let stdout = '', stderr = '';
        let killed = false;
        const timer = setTimeout(() => {
            killed = true;
            proc.kill('SIGTERM');
            setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 5000);
        }, CRAWLER_TIMEOUT);

        proc.stdout.on('data', d => { stdout += d.toString(); });
        proc.stderr.on('data', d => { stderr += d.toString(); });

        proc.on('close', code => {
            clearTimeout(timer);
            childProcesses.delete(procId);
            if (killed) return reject(new Error(`爬虫执行超时`));
            if (code === 0) return resolve({ stdout, stderr });
            reject(new Error(`进程退出码 ${code}: ${stderr || stdout}`));
        });
        proc.on('error', err => {
            clearTimeout(timer);
            childProcesses.delete(procId);
            reject(err);
        });
    });
}

function sendToRenderer(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

// ========== 文件检查 ==========
function hasNewFilesInDataDir(startTime) {
    function scan(dir, depth = 0) {
        if (depth > 2) return false;
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (scan(full, depth + 1)) return true;
                } else if (entry.isFile() && fs.statSync(full).mtimeMs > startTime) {
                    return true;
                }
            }
        } catch {}
        return false;
    }
    return scan(dataDir);
}

// ========== 单个爬虫 ==========
async function runCrawler(name, scriptName, requiresLogin) {
    const scriptPath = getScriptPath(scriptName);
    if (!fs.existsSync(scriptPath)) {
        sendToRenderer('crawler-status', { name, status: 'error', message: `脚本不存在: ${scriptPath}` });
        return { success: false, error: `脚本不存在: ${scriptPath}` };
    }

    // 需要登录则获取互斥锁（排队）
    if (requiresLogin) {
        sendToRenderer('crawler-status', { name, status: 'waiting-login', message: `正在排队等待登录...` });
        await acquireLoginSlot(name);
    }

    sendToRenderer('crawler-status', { name, status: 'running', message: `正在运行 ${name}...` });

    const startTime = Date.now();
    try {
        const result = await runPythonScript(scriptPath, ['--data-dir', dataDir, '--action', 'crawl']);
        // 判定成功：脚本输出 JSON 中 success=true 或 有新文件
        const lines = result.stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1].trim();
        let scriptSuccess = false;
        if (lastLine.startsWith('{')) {
            try {
                const data = JSON.parse(lastLine);
                scriptSuccess = data.success === true;
            } catch {}
        }
        if (!scriptSuccess && !hasNewFilesInDataDir(startTime)) {
            throw new Error('爬虫运行完成但未生成任何输出文件');
        }
        sendToRenderer('crawler-status', { name, status: 'completed', message: `${name} 完成` });
        return { success: true, output: result.stdout };
    } catch (err) {
        sendToRenderer('crawler-status', { name, status: 'error', message: `${name} 失败: ${err.message}` });
        return { success: false, error: err.message };
    } finally {
        if (requiresLogin) releaseLoginSlot(name);
    }
}

// ========== 一键爬取 ==========
async function runAllCrawlers() {
    const crawlerScripts = [
        { name: '爬虫A-专利公告', script: '01_专利过期监控爬虫_v2.py', requiresLogin: false },
        { name: '爬虫B-天眼查', script: '02_天眼查专利导出.py', requiresLogin: true },
        { name: '爬虫C-CNIPA', script: '03_CNIPA专利导出.py', requiresLogin: true },
    ];

    const promises = crawlerScripts.map(c => runCrawler(c.name, c.script, c.requiresLogin));
    const results = await Promise.allSettled(promises);
    const finalResults = results.map((r, i) => ({
        name: crawlerScripts[i].name,
        status: r.status === 'fulfilled' ? (r.value?.success ? 'completed' : 'error') : 'error',
        message: r.status === 'fulfilled' ? (r.value?.success ? '完成' : (r.value?.error || '未知错误')) : '进程异常',
    }));

    // 统计成功数量，决定是否提示清洗
    const successCount = finalResults.filter(r => r.status === 'completed').length;
    if (successCount > 0) {
        sendToRenderer('crawler-status', {
            name: 'all',
            status: 'completed',
            message: `一键爬取完成（${successCount}/${crawlerScripts.length} 成功），建议运行清洗`,
            allDone: true,
            suggestClean: true
        });
    } else {
        sendToRenderer('crawler-status', {
            name: 'all',
            status: 'error',
            message: '一键爬取失败，所有爬虫均未成功',
            allDone: true
        });
    }
    return finalResults;
}

// ========== 清洗 ==========
async function runCleaning() {
    sendToRenderer('cleaning-status', { status: 'running', message: '正在清洗数据...' });
    try {
        const scriptPath = getScriptPath('00_数据清洗融合.py');
        if (!fs.existsSync(scriptPath)) throw new Error(`脚本不存在: ${scriptPath}`);
        await runPythonScript(scriptPath, ['--data-dir', dataDir]);
        sendToRenderer('cleaning-status', { status: 'completed', message: '数据清洗完成' });
        return { success: true };
    } catch (err) {
        sendToRenderer('cleaning-status', { status: 'error', message: `清洗失败: ${err.message}` });
        return { success: false, error: err.message };
    }
}

function readCleanedJson() {
    const p = path.join(dataDir, 'cleaned_data', '专利数据_清洗融合.json');
    if (!fs.existsSync(p)) return null;
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return Array.isArray(raw) ? { patents: raw } : raw;
    } catch { return null; }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400, height: 900,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        title: '专利监控看板',
    });
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    if (!app.isPackaged) mainWindow.webContents.openDevTools();
    mainWindow.on('closed', () => { mainWindow = null; });
}

// ========== IPC ==========
function setupIPC() {
    ipcMain.handle('get-data', () => {
        const data = readCleanedJson();
        return { success: true, data: data || { patents: [] } };
    });
    ipcMain.handle('run-all-crawlers', async () => {
        const results = await runAllCrawlers();
        return { success: true, results };
    });
    ipcMain.handle('run-cleaning', runCleaning);
    ipcMain.handle('get-data-dir', () => dataDir);
    ipcMain.handle('get-user-data-dir', () => userDataDir);
}

// ========== 生命周期 ==========
app.whenReady().then(() => {
    initPaths();
    setupIPC();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
    for (const proc of childProcesses.values()) {
        try { proc.kill('SIGTERM'); } catch {}
    }
    childProcesses.clear();
});