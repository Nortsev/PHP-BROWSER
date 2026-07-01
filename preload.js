const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  scanFolders: () => ipcRenderer.invoke('scan-folders'),
  getDirectories: () => ipcRenderer.invoke('get-directories'),
  addDirectory: () => ipcRenderer.invoke('add-directory'),
  removeDirectory: (dir) => ipcRenderer.invoke('remove-directory', dir),
  copyFolder: (folder) => ipcRenderer.invoke('copy-folder', folder),
  revealInFinder: (folder) => ipcRenderer.invoke('reveal-in-finder', folder),
  setPhpRoot: (dir) => ipcRenderer.invoke('set-php-root', dir),
  listLandingPhpFiles: (folder) => ipcRenderer.invoke('list-landing-php-files', folder),
  getLandingSource: (folder, file) => ipcRenderer.invoke('get-landing-source', folder, file),
  saveLandingSource: (folder, content, file) => ipcRenderer.invoke('save-landing-source', folder, content, file),
  replaceVideo: (folder) => ipcRenderer.invoke('replace-video', folder),
  getVideoEncodeStatus: () => ipcRenderer.invoke('get-video-encode-status'),
  confirmSwitchDuringEncode: (label) => ipcRenderer.invoke('confirm-switch-during-encode', label),
  duplicateLanding: (folder) => ipcRenderer.invoke('duplicate-landing', folder),
  searchContent: (query) => ipcRenderer.invoke('search-content', query),
  getBookmarks: () => ipcRenderer.invoke('get-bookmarks'),
  toggleBookmark: (folder) => ipcRenderer.invoke('toggle-bookmark', folder),
  isBookmarked: (folder) => ipcRenderer.invoke('is-bookmarked', folder),
  getRecents: () => ipcRenderer.invoke('get-recents'),
  addRecent: (folder) => ipcRenderer.invoke('add-recent', folder),
  getEditorHistory: (folder, file) => ipcRenderer.invoke('get-editor-history', folder, file),
  getEditorHistoryContent: (folder, index, file) => ipcRenderer.invoke('get-editor-history-content', folder, index, file),
  checkMimo: () => ipcRenderer.invoke('check-mimo'),
  promptInstallMimo: () => ipcRenderer.invoke('prompt-install-mimo'),
  getMimoInstallCommand: () => ipcRenderer.invoke('get-mimo-install-command'),
  getTerminalCwd: (folder) => ipcRenderer.invoke('get-terminal-cwd', folder),
  terminalStart: (cwd) => ipcRenderer.invoke('terminal-start', cwd),
  terminalWrite: (data) => ipcRenderer.invoke('terminal-write', data),
  terminalResize: (cols, rows) => ipcRenderer.invoke('terminal-resize', cols, rows),
  terminalKill: () => ipcRenderer.invoke('terminal-kill'),
  onTerminalData: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('terminal-data', handler);
    return () => ipcRenderer.removeListener('terminal-data', handler);
  },
  onTerminalExit: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('terminal-exit', handler);
    return () => ipcRenderer.removeListener('terminal-exit', handler);
  },
  onVideoEncodeProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('video-encode-progress', handler);
    return () => ipcRenderer.removeListener('video-encode-progress', handler);
  },
  onPhpServerError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('php-server-error', handler);
    return () => ipcRenderer.removeListener('php-server-error', handler);
  },
  onConfigPruned: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('config-pruned', handler);
    return () => ipcRenderer.removeListener('config-pruned', handler);
  },
});
