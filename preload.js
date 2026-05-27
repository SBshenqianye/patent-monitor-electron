const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getData: () => ipcRenderer.invoke('get-data'),
    runAllCrawlers: () => ipcRenderer.invoke('run-all-crawlers'),
    runCleaning: () => ipcRenderer.invoke('run-cleaning'),
    getDataDir: () => ipcRenderer.invoke('get-data-dir'),
    getUserDataDir: () => ipcRenderer.invoke('get-user-data-dir'),

    // 事件监听
    onCrawlerStatus: (callback) => ipcRenderer.on('crawler-status', (event, data) => callback(data)),
    onCleaningStatus: (callback) => ipcRenderer.on('cleaning-status', (event, data) => callback(data)),

    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});