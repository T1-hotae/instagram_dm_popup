// 오른쪽 아래 알림 팝업(popup.html)용 preload. 팝업은 클릭·닫기 두 가지만 메인에 알린다.
// 보여 줄 내용(이름·본문·사진·소리 여부)은 main.js showPopup이 URL 쿼리 ?d=로 넘긴다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popup', {
  click: () => ipcRenderer.send('popup:click'),
  close: () => ipcRenderer.send('popup:close'),
});
