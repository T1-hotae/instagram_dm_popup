// 채팅 창(대화 하나만 띄운 창)에 붙는 preload.
// 대화 헤더·메시지·입력창만 남기고 왼쪽 메뉴, 대화 목록, 하단 탭바를 숨긴다.
// Instagram 클래스 이름은 자주 바뀌므로 모양과 위치로 판정한다. 판정이 빗나가면 숨기지 못할 뿐 채팅은 그대로 된다.
// 숨기기는 DOM만 만지므로 isolated world에서 한다. 읽음 막기만 페이지 세계에 코드를 넣는다.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// 읽음 막기: 창에 포커스가 없으면 페이지에 "숨겨진 탭"으로 보이게 한다.
// Instagram은 대화가 열려 있고 화면이 보이면 새 메시지를 바로 읽음 처리하는데,
// 다른 창을 보고 있어도 이 창이 화면에 떠 있으면 visible이라 읽음이 되어 버렸다.
// 포커스가 돌아오면 visibilitychange를 보내 그때 읽음 처리되게 한다(카카오톡처럼 창을 봐야 읽음).
let activeHandler = null;
contextBridge.exposeInMainWorld('__instaDMChat', { onActive: (cb) => { activeHandler = cb; } });
ipcRenderer.on('chat:active', (_e, on) => {
  if (typeof activeHandler === 'function') activeHandler(!!on);
});

webFrame.executeJavaScript(`(() => {
  const bridge = window.__instaDMChat;
  if (!bridge || window.__instaDMChatInstalled) return;
  window.__instaDMChatInstalled = true;
  let active = true;
  const proto = Document.prototype;
  const realVis = Object.getOwnPropertyDescriptor(proto, 'visibilityState').get;
  const realHidden = Object.getOwnPropertyDescriptor(proto, 'hidden').get;
  const realHasFocus = proto.hasFocus;
  Object.defineProperty(proto, 'visibilityState', { configurable: true,
    get() { return active ? realVis.call(this) : 'hidden'; } });
  Object.defineProperty(proto, 'hidden', { configurable: true,
    get() { return active ? realHidden.call(this) : true; } });
  proto.hasFocus = function () { return active && realHasFocus.call(this); };
  bridge.onActive((on) => {
    if (on === active) return;
    active = on;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(on ? 'focus' : 'blur'));
  });
})();`).catch(() => {});

const HIDDEN = 'data-insta-dm-hidden';

function hide(el) {
  if (el.hasAttribute(HIDDEN)) return;
  el.setAttribute(HIDDEN, '');
  el.style.setProperty('display', 'none', 'important');
}

// 메뉴 막대: 탐색·릴스 링크에서 위로 올라가며 "막대 모양"(세로로 좁고 길거나, 가로로 납작함)인 가장 바깥 칸.
// 왼쪽 세로 메뉴와 아래쪽 탭바 둘 다 이 모양이다.
function hideNav() {
  document.querySelectorAll('a[href="/explore/"], a[href="/reels/"]').forEach((a) => {
    let bar = null;
    for (let n = a.parentElement; n && n !== document.body; n = n.parentElement) {
      const r = n.getBoundingClientRect();
      if ((r.width <= 260 && r.height > 300) || r.height <= 70) bar = n;
      else break;
    }
    if (bar) hide(bar);
  });
}

// 대화 목록 열: 입력창에서 위로 올라가며, 화면 높이만 한 칸의 형제 중 좌우로 비켜 있는 것(목록, 메뉴 자리 확보용 빈 칸)
function hideSideColumns() {
  const box = document.querySelector('[role="textbox"][contenteditable="true"], textarea');
  if (!box) return;
  for (let n = box.parentElement; n && n !== document.body; n = n.parentElement) {
    const pr = n.getBoundingClientRect();
    if (pr.height < window.innerHeight * 0.6) continue; // 입력창 줄의 버튼(사진, 이모지)은 건드리지 않는다
    for (const s of n.parentElement ? n.parentElement.children : []) {
      if (s === n || s.hasAttribute(HIDDEN)) continue;
      const r = s.getBoundingClientRect();
      if (r.width > 0 && (r.right <= pr.left + 1 || r.left >= pr.right - 1)) hide(s);
      // 아래쪽 형제: 숨긴 하단 탭바 자리를 비워 두는 빈 칸
      else if (r.height > 0 && r.top >= pr.bottom - 1) hide(s);
    }
  }
  trimBottom(box);
}

// 아래 여백: 입력창 아래가 크게 비어 있으면(하단 탭바 높이만큼 남겨 둔 자리) 조상의 아래쪽 안쪽·바깥 여백을 없애고,
// 화면 높이에서 탭바만큼 뺀 고정 높이를 화면 높이로 늘린다.
function trimBottom(box) {
  if (window.innerHeight - box.getBoundingClientRect().bottom < 40) return;
  for (let n = box.parentElement; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (parseFloat(cs.paddingBottom) >= 30) n.style.setProperty('padding-bottom', '0', 'important');
    if (parseFloat(cs.marginBottom) >= 30) n.style.setProperty('margin-bottom', '0', 'important');
    const r = n.getBoundingClientRect();
    const short = window.innerHeight - r.height;
    if (r.top < 1 && r.height >= window.innerHeight * 0.6 && short >= 30 && short <= 80) {
      n.style.setProperty('height', '100vh', 'important');
      n.style.setProperty('max-height', 'none', 'important');
    }
  }
}

let timer = null;
function scan() {
  timer = null;
  try {
    hideNav();
    hideSideColumns();
  } catch {
    // 화면 구조가 바뀜. 숨기지 않은 채로 둔다
  }
}
const scanSoon = () => { if (!timer) timer = setTimeout(scan, 200); };

window.addEventListener('DOMContentLoaded', () => {
  scan();
  new MutationObserver(scanSoon).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', scanSoon);
});

// Esc = 창 닫기 (카카오톡처럼). 페이지가 이미 처리했거나(이모지 창 닫기 등) 대화 상자가 떠 있으면 두지 않는다.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="dialog"]')) return;
  ipcRenderer.send('chat:close');
});
