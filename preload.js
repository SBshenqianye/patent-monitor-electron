const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getData: () => ipcRenderer.invoke('get-data'),
    runAllCrawlers: () => ipcRenderer.invoke('run-all-crawlers'),
    runCleaning: () => ipcRenderer.invoke('run-cleaning'),
    getDataDir: () => ipcRenderer.invoke('get-data-dir'),
    getUserDataDir: () => ipcRenderer.invoke('get-user-data-dir'),

    onCrawlerStatus: (callback) => ipcRenderer.on('crawler-status', (event, data) => callback(data)),
    onCleaningStatus: (callback) => ipcRenderer.on('cleaning-status', (event, data) => callback(data)),
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),

    // 手动导入
    openTempFolder: () => ipcRenderer.invoke('open-temp-folder'),
    getTempDataDir: () => ipcRenderer.invoke('get-temp-data-dir'),
    getTempDataStructure: () => ipcRenderer.invoke('get-temp-data-structure'),
    getManualImportIgnore: () => ipcRenderer.invoke('get-manual-import-ignore'),
    setManualImportIgnore: (ignore) => ipcRenderer.invoke('set-manual-import-ignore', ignore),

    // 导出 Excel
    exportToExcel: (data) => ipcRenderer.invoke('export-to-excel', data),

    // 使用教程弹窗
    getTutorialIgnore: () => ipcRenderer.invoke('get-tutorial-ignore'),
    setTutorialIgnore: (ignore) => ipcRenderer.invoke('set-tutorial-ignore', ignore),


    // 拖拽导入（这两个必须存在）
    onDroppedFiles: (callback) => ipcRenderer.on('dropped-files', (event, filePaths) => callback(filePaths)),
    importFiles: (filePaths, targetFolder) => ipcRenderer.invoke('import-files', filePaths, targetFolder),

    getHeadlessMode: () => ipcRenderer.invoke('get-headless-mode'),
    setHeadlessMode: (headless) => ipcRenderer.invoke('set-headless-mode', headless),
});