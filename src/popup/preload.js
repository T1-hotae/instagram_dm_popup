// 오른쪽 아래 알림 팝업(popup.html)용 preload. 팝업은 클릭·닫기 두 가지만 메인에 알린다.
// 보여 줄 내용(이름·메시지·입력 중·사진·소리 여부)은 main.js가 'popup:update'로 보낸다.
// 같은 대화의 새 소식도 창을 새로 만들지 않고 이 채널로 내용만 바꾼다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popup', {
  click: () => ipcRenderer.send('popup:click'),
  close: () => ipcRenderer.send('popup:close'),
  onUpdate: (fn) => ipcRenderer.on('popup:update', (_e, d) => fn(d)),
});
