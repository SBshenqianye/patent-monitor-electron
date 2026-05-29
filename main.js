const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const XLSX = require('xlsx');  // 需要 npm install xlsx

let mainWindow = null;
let userDataDir = null;
let dataDir = null;
let scriptsDir = null;
let tempDataDir = null;

const childProcesses = new Map();
const CRAWLER_TIMEOUT = 5 * 60 * 1000;    // 5 分钟

// 登录互斥锁
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
    tempDataDir = path.join(dataDir, 'temp_data');
    
    if (app.isPackaged) {
        // 生产环境：extraResources 下的所有 exe 直接位于 resources/extraResources/
        scriptsDir = path.join(process.resourcesPath, 'extraResources');
    } else {
        // 开发环境：python 脚本位于项目根目录的 patent_crawlers/
        scriptsDir = path.join(__dirname, 'patent_crawlers');
    }
    
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(tempDataDir, { recursive: true });
    
    // 确保三个子目录存在
    const subDirs = ['中国专利公布公告网', '天眼查', '专利检索及分析网'];
    for (const sub of subDirs) {
        fs.mkdirSync(path.join(tempDataDir, sub), { recursive: true });
    }
}

function getScriptPath(scriptName) {
    // scriptName 例如 "02_天眼查专利导出.py"
    if (app.isPackaged) {
        // 生产环境：将 .py 后缀替换为 .exe，直接位于 scriptsDir 根目录
        const exeName = scriptName.replace(/\.py$/, '.exe');
        const exePath = path.join(scriptsDir, exeName);
        if (fs.existsSync(exePath)) {
            return exePath;
        }
        throw new Error(`打包后的可执行文件不存在: ${exePath}`);
    } else {
        // 开发环境：使用原始 .py 文件
        const pyPath = path.join(scriptsDir, scriptName);
        if (fs.existsSync(pyPath)) {
            return pyPath;
        }
        throw new Error(`Python 脚本不存在: ${pyPath}`);
    }
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

// 辅助函数：快速检测脚本是否需要登录（仅用于需要登录的爬虫）
async function checkLoginStatus(scriptPath) {
    try {
        const result = await runPythonScript(scriptPath, ['--data-dir', dataDir, '--action', 'check']);
        const lines = result.stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1].trim();
        if (lastLine.startsWith('{')) {
            const data = JSON.parse(lastLine);
            return data.loggedIn === true;
        }
    } catch (err) {
        console.warn('登录状态检测失败:', err);
    }
    return false;  // 保守认为未登录
}

// ========== 单个爬虫（最终版） ==========
async function runCrawler(name, scriptName, requiresLogin) {
    const scriptPath = getScriptPath(scriptName);
    if (!fs.existsSync(scriptPath)) {
        sendToRenderer('crawler-status', { name, status: 'error', message: `脚本不存在: ${scriptPath}` });
        return { success: false, error: `脚本不存在: ${scriptPath}` };
    }

    const config = readUserConfig();
    let useHeadless = config.headless !== false;
    let lastError = null;
    const maxAttempts = 4;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let startMinimized = false;
        let needLoginQueue = false;

        // ===== 决定是否最小化和是否需要排队登录 =====
        if (useHeadless) {
            // 无头模式：不显示窗口，无需最小化，也不排队
            startMinimized = false;
            needLoginQueue = false;
        } else {
            // 有头模式
            if (!requiresLogin) {
                // 无需登录的爬虫 → 总是最小化
                startMinimized = true;
                needLoginQueue = false;
            } else {
                // 需要登录的爬虫 → 先检测登录状态
                const loggedIn = await checkLoginStatus(scriptPath);
                if (loggedIn) {
                    startMinimized = true;   // 已登录 → 最小化窗口直接爬
                    needLoginQueue = false;
                    sendToRenderer('crawler-status', {
                        name,
                        status: 'info',
                        message: `${name} 已登录，将最小化运行`
                    });
                } else {
                    startMinimized = false;  // 未登录 → 显示窗口供扫码
                    needLoginQueue = true;
                }
            }
        }

        // ===== 排队登录（仅当需要时） =====
        if (needLoginQueue) {
            sendToRenderer('crawler-status', { name, status: 'waiting-login', message: `正在排队等待登录...` });
            await acquireLoginSlot(name);
        }

        // 构建参数
        const args = [
            '--data-dir', dataDir,
            '--action', 'crawl',
            '--headless', useHeadless ? 'true' : 'false',
        ];
        if (!useHeadless && startMinimized) {
            args.push('--start-minimized');
        }

        sendToRenderer('crawler-status', {
            name,
            status: 'running',
            message: `正在运行 ${name}（第 ${attempt}/${maxAttempts} 次${useHeadless ? '，无头' : '，有头'}）`
        });

        const startTime = Date.now();
        try {
            const result = await runPythonScript(scriptPath, args);
            const lines = result.stdout.trim().split('\n');
            const lastLine = lines[lines.length - 1].trim();
            let data = {};
            if (lastLine.startsWith('{')) {
                try { data = JSON.parse(lastLine); } catch (e) {
                    console.error('JSON 解析失败:', lastLine);
                }
            }

            // 成功
            if (data.success) {
                if (needLoginQueue) releaseLoginSlot(name);
                sendToRenderer('crawler-status', { name, status: 'completed', message: `${name} 完成` });
                return { success: true, output: result.stdout };
            }

            // 无头且需要登录 → 切换有头重试
            if (data.requireLogin && useHeadless) {
                console.log(`[runCrawler] ${name} 无头需要登录，切换有头`);
                useHeadless = false;
                if (needLoginQueue) releaseLoginSlot(name);  // 安全释放
                continue;
            }

            // 其他失败
            throw new Error(data.error || '爬虫返回失败');

        } catch (err) {
            if (needLoginQueue) releaseLoginSlot(name);
            lastError = err;

            // 无头模式失败且还有重试次数，切有头重试
            if (useHeadless && attempt < maxAttempts) {
                console.log(`[runCrawler] ${name} 无头失败，切换有头重试`);
                useHeadless = false;
                continue;
            }
            break;
        } finally {
            // 确保登录槽释放（有头但未排队的情况下不需要释放，但 releaseLoginSlot 可重复调用安全）
            if (needLoginQueue) releaseLoginSlot(name);
        }
    }

    const finalMsg = lastError ? lastError.message : '达到最大重试次数';
    sendToRenderer('crawler-status', {
        name,
        status: 'error',
        message: `${name} 失败: ${finalMsg}${maxAttempts > 1 ? '，无头模式可能被检测，建议使用有头模式' : ''}`,
        suggestRetry: true
    });
    return { success: false, error: finalMsg };
}
// ========== 一键爬取 ==========
async function runAllCrawlers() {
    const crawlerScripts = [
        { name: '爬虫A-专利公告', script: '01_专利过期监控爬虫_v2.py', requiresLogin: false },
        { name: '爬虫B-天眼查', script: '02_天眼查专利导出.py', requiresLogin: true },
        // { name: '爬虫C-CNIPA', script: '03_CNIPA专利导出.py', requiresLogin: true },
    ];

    const promises = crawlerScripts.map(c => runCrawler(c.name, c.script, c.requiresLogin));
    const results = await Promise.allSettled(promises);
    const finalResults = results.map((r, i) => ({
        name: crawlerScripts[i].name,
        status: r.status === 'fulfilled' ? (r.value?.success ? 'completed' : 'error') : 'error',
        message: r.status === 'fulfilled' ? (r.value?.success ? '完成' : (r.value?.error || '未知错误')) : '进程异常',
    }));

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

// ========== 目录树递归 ==========
function getDirectoryTree(dirPath, depth = 0, maxDepth = 3) {
    if (depth > maxDepth) return {
        name: path.basename(dirPath),
        type: 'dir',
        truncated: true,
        children: []
    };
    const stats = fs.statSync(dirPath);
    const item = {
        name: path.basename(dirPath),
        type: stats.isDirectory() ? 'dir' : 'file',
        path: dirPath,
    };
    if (stats.isDirectory()) {
        item.children = [];
        try {
            const entries = fs.readdirSync(dirPath);
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry);
                try {
                    const entryStats = fs.statSync(fullPath);
                    if (entryStats.isDirectory() || /\.(xlsx|csv|json)$/i.test(entry)) {
                        item.children.push(getDirectoryTree(fullPath, depth + 1, maxDepth));
                    }
                } catch (err) {}
            }
        } catch (err) {}
    }
    return item;
}

// 用户配置
const configPath = path.join(app.getPath('userData'), 'userConfig.json');
function readUserConfig() {
    try {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        }
    } catch (err) {}
    return {};
}
function writeUserConfig(config) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// ========== IPC 处理 ==========
function setupIPC() {
    // 获取 headless 设置
    ipcMain.handle('get-headless-mode', () => {
        const config = readUserConfig();
        return { headless: config.headless !== false };   // 默认 true（无头）
    });
    // 设置 headless 模式
    ipcMain.handle('set-headless-mode', (event, headless) => {
        const config = readUserConfig();
        config.headless = headless;
        writeUserConfig(config);
        return { success: true };
    });
    // 拖拽导入文件
    ipcMain.handle('import-files', async (event, filePaths, targetFolder) => {
        const validFolders = ['中国专利公布公告网', '天眼查', '专利检索及分析网'];
        if (!validFolders.includes(targetFolder)) {
            return { success: false, error: '无效的目标文件夹' };
        }
        const destDir = path.join(tempDataDir, targetFolder);
        fs.mkdirSync(destDir, { recursive: true });

        let count = 0;
        for (const src of filePaths) {
            try {
                const filename = path.basename(src);
                fs.copyFileSync(src, path.join(destDir, filename));
                count++;
            } catch (err) {
                // 可记录日志，此处忽略单文件失败继续复制
            }
        }
        if (count === 0) return { success: false, error: '没有文件被成功复制' };
        return { success: true, count };
    });
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
    
    // 手动导入相关
    ipcMain.handle('open-temp-folder', async () => {
        if (tempDataDir && fs.existsSync(tempDataDir)) {
            shell.openPath(tempDataDir);
            return { success: true };
        }
        return { success: false, error: '临时数据目录不存在' };
    });
    ipcMain.handle('get-temp-data-dir', () => tempDataDir);
    ipcMain.handle('get-temp-data-structure', () => {
        if (!fs.existsSync(tempDataDir)) {
            fs.mkdirSync(tempDataDir, { recursive: true });
        }
        // 确保三个子目录存在
        const subDirs = ['中国专利公布公告网', '天眼查', '专利检索及分析网'];
        for (const sub of subDirs) {
            fs.mkdirSync(path.join(tempDataDir, sub), { recursive: true });
        }
        try {
            const tree = getDirectoryTree(tempDataDir);
            return { success: true, tree };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });
    ipcMain.handle('get-manual-import-ignore', () => {
        const config = readUserConfig();
        return { ignore: config.manualImportIgnore === true };
    });
    ipcMain.handle('set-manual-import-ignore', (event, ignore) => {
        const config = readUserConfig();
        config.manualImportIgnore = ignore;
        writeUserConfig(config);
        return { success: true };
    });
    // 在 setupIPC() 函数内，原有的手动导入 IPC 之后添加

    // 使用教程弹窗
    ipcMain.handle('get-tutorial-ignore', () => {
        const config = readUserConfig();
        return { ignore: config.tutorialIgnore === true };
    });
    ipcMain.handle('set-tutorial-ignore', (event, ignore) => {
        const config = readUserConfig();
        config.tutorialIgnore = ignore;
        writeUserConfig(config);
        return { success: true };
    });
    // 导出 Excel
    ipcMain.handle('export-to-excel', async (event, data) => {
        if (!data || !data.length) {
            return { success: false, error: '没有数据可导出' };
        }
        const columns = [
            { header: '申请号', key: 'applyId' },
            { header: '发明名称', key: 'title' },
            { header: '申请日', key: 'applyDate' },
            { header: '公开(公告)日', key: 'pubDate' },
            { header: '申请人', key: 'applicant' },
            { header: '公司', key: 'company' },
            { header: '发明人', key: 'inventor' },
            { header: 'IPC分类号', key: 'classification' },
            { header: '地址', key: 'address' },
            { header: '专利类型', key: 'patentType' },
            { header: '法律状态', key: 'legalStatus' },
            { header: '剩余天数', key: 'daysRemaining' },
            { header: '预计到期日', key: 'expiryDate' },
            { header: '专利代理机构', key: 'patentAgency' },
            { header: '专利代理师', key: 'patentAgent' },
            { header: '摘要', key: 'abstract' },
            { header: '来源', key: 'source' },
        ];
        const sheetData = [columns.map(c => c.header)];
        for (const item of data) {
            const row = columns.map(c => {
                let val = item[c.key];
                if (val === undefined || val === null) return '';
                if (c.key === 'daysRemaining' && val === null) return '';
                return val;
            });
            sheetData.push(row);
        }
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
        XLSX.utils.book_append_sheet(workbook, worksheet, '专利数据');
        const outputDir = path.join(process.cwd(), 'output');
        fs.mkdirSync(outputDir, { recursive: true });
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        const filename = `专利数据_导出_${timestamp}.xlsx`;
        const filepath = path.join(outputDir, filename);
        XLSX.writeFile(workbook, filepath);
        return { success: true, filepath };
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400, height: 900,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        frame: true,
        titleBarStyle: 'default',
        title: '专利监控看板',
    });

    // 开发者工具（调试用）
    if (!app.isPackaged) mainWindow.webContents.openDevTools();

    // 处理 target="_blank" 链接（例如手动导入弹窗中的外部链接）
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        // 允许天眼查和专利检索网链接用默认浏览器打开
        if (url.includes('tianyancha.com') || url.includes('pss-system.cponline.cnipa.gov.cn')) {
            shell.openExternal(url).catch(err => console.error('打开外部链接失败:', err));
        } else {
            // 其他所有新窗口请求一律阻止
            console.log('[主进程] 阻止打开新窗口:', url);
        }
        return { action: 'deny' };
    });

    // 保留原有的导航拦截，防止主框架意外跳转（可选，不影响新窗口）
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith('file://') || url === 'about:blank') {
            return;
        }
        // 如果是白名单链接，不拦截（实际上主框架导航极少发生，但以防万一）
        if (url.includes('tianyancha.com') || url.includes('pss-system.cponline.cnipa.gov.cn')) {
            // 也不应该让主窗口跳转，还是打开外部浏览器并阻止
            event.preventDefault();
            shell.openExternal(url).catch(err => console.error('打开外部链接失败:', err));
            return;
        }
        event.preventDefault();
        console.log('[主进程] 阻止导航到:', url);
    });

    // 允许拖放
    mainWindow.webContents.on('will-prevent-default', (event) => {
        event.preventDefault();
        console.log('[主进程 will-prevent-default] 允许拖放');
    });

    // 接收拖放文件路径
    mainWindow.on('drop-file', (event, filePaths) => {
        event.preventDefault();
        console.log('[主进程 drop-file] 获取到文件路径：', filePaths);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('dropped-files', filePaths);
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    mainWindow.on('closed', () => { mainWindow = null; });
}

// 生命周期
app.whenReady().then(() => {
    initPaths();
    setupIPC();
    
    Menu.setApplicationMenu(null);

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