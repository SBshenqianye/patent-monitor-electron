const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const EventEmitter = require('events');

let mainWindow = null;
let userDataDir = null;
let dataDir = null;
let scriptsDir = null;

// 子进程管理
const childProcesses = new Map();

// 登录等待事件（用于同一进程内 resolve Promise，替代 ipcMain.once 跨进程通信）
const loginEvents = new EventEmitter();

// ============================================================
// 路径初始化
// ============================================================
function initPaths() {
    userDataDir = app.getPath('userData');
    dataDir = path.join(userDataDir, 'data');
    // 在开发模式下，脚本在项目内的 patent_crawlers/ 目录；打包后在 extraResources/patent_crawlers/
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

// ============================================================
// 获取脚本完整路径（优先 exe，其次 .py）
// ============================================================
function getScriptPath(scriptName) {
    const pyPath = path.join(scriptsDir, scriptName);
    const exePath = pyPath.replace(/\.py$/, '.exe');
    if (fs.existsSync(exePath)) return exePath;
    if (fs.existsSync(pyPath)) return pyPath;
    return pyPath;
}

// ============================================================
// 执行 Python 脚本（使用命名参数 --data-dir 等）
// ============================================================
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
// 通知渲染进程
// ============================================================
function sendToRenderer(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

// ============================================================
// 爬虫执行逻辑（所有爬虫均使用 --data-dir + --action 命名参数）
// ============================================================
async function runCrawler(name, scriptName, requiresLogin) {
    const scriptPath = getScriptPath(scriptName);

    if (!fs.existsSync(scriptPath)) {
        sendToRenderer('crawler-status', { name, status: 'error', message: `${name} 失败: 脚本不存在: ${scriptPath}` });
        return { success: false, error: `脚本不存在: ${scriptPath}` };
    }

    // 检查并引导登录（仅对需要登录的爬虫）
    if (requiresLogin) {
        sendToRenderer('login-required', { name, needLogin: true, message: `"${name}" 需要登录，请点击「开始登录」打开浏览器完成登录` });
        // 等待用户确认登录（使用 EventEmitter 在进程内通信，5 分钟超时）
        await new Promise((resolve) => {
            loginEvents.once(`login-done-${name}`, resolve);
            setTimeout(() => {
                loginEvents.removeAllListeners(`login-done-${name}`);
                resolve();
            }, 5 * 60 * 1000);
        });
    }

    sendToRenderer('crawler-status', { name, status: 'running', message: `正在运行 ${name}...` });

    try {
        const result = await runPythonScript(scriptPath, ['--data-dir', dataDir, '--action', 'crawl']);
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
        { name: '爬虫B-CNIPA', script: '03_CNIPA专利导出.py', requiresLogin: true },
        { name: '爬虫C-天眼查', script: '02_天眼查专利导出.py', requiresLogin: true },
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

    // 通知所有爬虫完成
    sendToRenderer('crawler-status', { name: 'all', status: 'completed', message: '一键爬取完成', allDone: true });

    return finalResults;
}

// ============================================================
// 一键清洗
// ============================================================
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

// ============================================================
// 读取最终 JSON（兼容纯数组格式）
// ============================================================
function readCleanedJson() {
    const jsonPath = path.join(dataDir, "cleaned_data", '专利数据_清洗融合.json');
    if (!fs.existsSync(jsonPath)) return null;
    try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        // 如果输出是纯数组，包装成 { patents: [...] } 以兼容渲染层
        if (Array.isArray(raw)) {
            return { patents: raw };
        }
        return raw;
    } catch {
        return null;
    }
}

// ============================================================
// 生成示例数据（用于首次打开时展示）
// ============================================================
function generateSampleData() {
    return {
        patents: [],
        stats: {
            total_patents: 0,
            expired: 0,
            expiring_soon: 0,
            valid: 0,
            crawler_a_count: 0,
            crawler_b_count: 0,
            crawler_c_count: 0,
        },
        summary: {
            sourceA: '暂无数据',
            sourceB: '暂无数据',
            sourceC: '暂无数据',
        },
        timeline: [],
        pie_data: [],
        companies: []
    };
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
        if (data) {
            return { success: true, data };
        }
        return { success: true, data: generateSampleData() };
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

    // 检查登录状态（简化实现，实际由爬虫脚本在内部检测并发送 login-required）
    ipcMain.handle('check-login', async (event, name) => {
        // 这里可以查询某个标记文件，但为了简单，返回未登录，让前端调用 guide-login
        return { loggedIn: false };
    });

    // 引导登录（打开浏览器让用户登录）
    ipcMain.handle('guide-login', async (event, name) => {
        const scriptMap = {
            '爬虫B-CNIPA': '03_CNIPA专利导出.py',
            '爬虫C-天眼查': '02_天眼查专利导出.py',
        };
        const scriptName = scriptMap[name];
        if (!scriptName) return { success: false, error: '未知爬虫' };

        const scriptPath = getScriptPath(scriptName);
        if (!fs.existsSync(scriptPath)) {
            return { success: false, error: `脚本不存在: ${scriptPath}` };
        }

        try {
            // 以 --action login 模式启动脚本（可见浏览器）
            const result = await runPythonScript(scriptPath, ['--data-dir', dataDir, '--action', 'login']);
            // 触发登录完成事件（通知等待中的 runCrawler）
            loginEvents.emit(`login-done-${name}`);
            // 同时通知渲染进程登录已完成
            sendToRenderer('login-done', { name });
            return { success: true };
        } catch (err) {
            // 即使登录失败也要放行，否则 runCrawler 会永远等待
            loginEvents.emit(`login-done-${name}`);
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