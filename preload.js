const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // 获取数据
    getData: () => ipcRenderer.invoke('get-data'),

    // 一键爬取
    runAllCrawlers: () => ipcRenderer.invoke('run-all-crawlers'),

    // 一键清洗
    runCleaning: () => ipcRenderer.invoke('run-cleaning'),

    // 登录相关
    checkLogin: (name) => ipcRenderer.invoke('check-login', name),
    guideLogin: (name) => ipcRenderer.invoke('guide-login', name),

    // 获取路径
    getDataDir: () => ipcRenderer.invoke('get-data-dir'),
    getUserDataDir: () => ipcRenderer.invoke('get-user-data-dir'),

    // 事件监听（主进程推送到渲染进程）
    onCrawlerStatus: (callback) => {
        ipcRenderer.on('crawler-status', (event, data) => callback(data));
    },
    onCleaningStatus: (callback) => {
        ipcRenderer.on('cleaning-status', (event, data) => callback(data));
    },
    onLoginRequired: (callback) => {
        ipcRenderer.on('login-required', (event, data) => callback(data));
    },
    onLoginDone: (callback) => {
        ipcRenderer.on('login-done', (event, data) => callback(data));
    },

    // 移除监听
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    },
});