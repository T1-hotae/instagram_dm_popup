// 메인 창 위쪽 타이틀바(titlebar.html)용 preload
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('titlebar', {
  minimize: () => ipcRenderer.send('titlebar:minimize'),
  toggleMaximize: () => ipcRenderer.send('titlebar:maximize'),
  close: () => ipcRenderer.send('titlebar:close'),
  openMenu: (x, y) => ipcRenderer.send('titlebar:menu', { x, y }),
  onState: (cb) => ipcRenderer.on('titlebar:state', (_e, s) => cb(s)),
});
