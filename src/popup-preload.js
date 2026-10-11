const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popup', {
  click: () => ipcRenderer.send('popup:click'),
  close: () => ipcRenderer.send('popup:close'),
});
