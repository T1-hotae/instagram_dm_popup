// Instagram 페이지(메인 창의 igView)에 붙는 preload.
// 1) 웹 Notification API를 가로채 메인 프로세스로 보내고 (→ 우측 하단 팝업)
// 2) 탭 제목의 "(N)" 읽지 않음 숫자를 감시하고
// 3) 받은편지함 목록의 프로필 사진 클릭을 스토리 대신 대화 열기로 바꾼다.
//
// preload는 페이지와 다른 JS 세계(isolated world)에서 돈다. 그래서 페이지의 window.Notification을
// 바꾸려면 webFrame.executeJavaScript로 페이지 세계에 코드를 넣고, 그 코드는 contextBridge로
// 열어 둔 window.__instaDM으로만 이쪽과 말한다.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

let clickHandler = null;

contextBridge.exposeInMainWorld('__instaDM', {
  notify: (n) => ipcRenderer.send('dm:notify', n),
  onClick: (cb) => { clickHandler = cb; },
  avatarClick: () => ipcRenderer.send('dm:avatar-click'),
});

ipcRenderer.on('dm:click', (_e, id) => {
  if (typeof clickHandler === 'function') clickHandler(id);
});

// 페이지(main world)에서 실행되는 코드: Notification 교체
webFrame.executeJavaScript(`(() => {
  const bridge = window.__instaDM;
  if (!bridge || window.__instaDMInstalled) return;
  window.__instaDMInstalled = true;

  const registry = new Map();
  let seq = 0;
  const str = (v) => (v == null ? '' : String(v));

  class DMNotification extends EventTarget {
    constructor(title, opts = {}) {
      super();
      this.title = str(title);
      this.body = str(opts.body);
      this.icon = str(opts.icon);
      this.tag = str(opts.tag);
      this.data = opts.data;
      this.onclick = this.onshow = this.onclose = this.onerror = null;
      const id = ++seq;
      registry.set(id, this);
      setTimeout(() => registry.delete(id), 10 * 60 * 1000);
      bridge.notify({ id, title: this.title, body: this.body, icon: this.icon, tag: this.tag,
        url: opts.data && typeof opts.data.url === 'string' ? opts.data.url : '' });
      setTimeout(() => this._fire('show'), 0);
    }
    _fire(type) {
      const ev = new Event(type);
      this.dispatchEvent(ev);
      const h = this['on' + type];
      if (typeof h === 'function') h.call(this, ev);
    }
    close() { this._fire('close'); }
    static get permission() { return 'granted'; }
    static requestPermission(cb) {
      if (typeof cb === 'function') cb('granted');
      return Promise.resolve('granted');
    }
  }
  DMNotification.maxActions = 0;

  bridge.onClick((id) => {
    const n = registry.get(id);
    if (n) { window.focus(); n._fire('click'); }
  });

  window.Notification = DMNotification;

  if (window.ServiceWorkerRegistration) {
    ServiceWorkerRegistration.prototype.showNotification = function (title, opts = {}) {
      bridge.notify({ id: 0, title: str(title), body: str(opts.body), icon: str(opts.icon),
        tag: str(opts.tag), url: opts.data && typeof opts.data.url === 'string' ? opts.data.url : '' });
      return Promise.resolve();
    };
  }

  if (navigator.permissions && navigator.permissions.query) {
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: 'granted', name: 'notifications', onchange: null,
            addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } })
        : query(p);
  }

  // 받은편지함 목록의 프로필 사진(스토리 링)을 누르면 스토리 대신 그 대화를 연다.
  // 목록 한 줄 판정은 감시 창(watcher/preload.js rowCandidates)과 같은 기준.
  const isRow = (n) => {
    if (n.matches('a[href*="/direct/t/"]')) return true;
    if (!n.matches('[role="button"], [role="listitem"], [role="link"]')) return false;
    const r = n.getBoundingClientRect();
    if (r.height < 44 || r.height > 120 || r.width < 150 || !n.querySelector('img')) return false;
    return (n.innerText || '').split('\\n').filter((s) => s.trim()).length >= 2;
  };
  const rowOf = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) if (isRow(n)) return n;
    return null;
  };
  // 같은 왼쪽 위치·폭의 줄이 여러 개 있어야 목록 (대화방 위쪽 헤더는 제외)
  const inList = (row) => {
    const a = row.getBoundingClientRect();
    return [...document.querySelectorAll('a[href*="/direct/t/"], [role="button"], [role="listitem"], [role="link"]')]
      .filter((n) => {
        if (n === row) return false;
        const b = n.getBoundingClientRect();
        return Math.abs(b.left - a.left) < 2 && Math.abs(b.width - a.width) < 2 && isRow(n);
      }).length >= 2;
  };
  const isAvatar = (t) => {
    if (t.closest('a[href*="/stories/"]')) return true;
    if (t.tagName === 'IMG' || t.tagName === 'CANVAS') return true;
    const box = t.closest('[role="button"], [role="link"], a');
    if (!box || !box.querySelector('img, canvas')) return false;
    const r = box.getBoundingClientRect();
    return r.width <= 80 && r.height <= 80;
  };
  const avatarRow = (e) => {
    if (!location.pathname.startsWith('/direct/') || !(e.target instanceof Element)) return null;
    if (!isAvatar(e.target)) return null;
    const row = rowOf(e.target);
    return row && inList(row) ? row : null;
  };
  const openRow = (row) => {
    const link = row.matches('a[href*="/direct/t/"]') ? row : row.querySelector('a[href*="/direct/t/"]');
    if (link) return link.click();
    // 링크가 없는 구조면 사진이 아닌 글자(이름)를 눌러 Instagram이 대화를 열게 한다
    const name = [...row.querySelectorAll('span')]
      .find((s) => s.childElementCount === 0 && s.textContent.trim() && !isAvatar(s));
    (name || row).click();
  };
  const guard = (e) => {
    const row = avatarRow(e);
    if (!row) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click') {
      bridge.avatarClick();
      openRow(row);
    }
  };
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) =>
    window.addEventListener(type, guard, true));
})();`);

// 탭 제목 "(3) Instagram" → 읽지 않음 3
let lastCount = -1;
function reportUnread() {
  const m = /^\((\d+)\)/.exec(document.title || '');
  const count = m ? parseInt(m[1], 10) : 0;
  if (count !== lastCount) {
    lastCount = count;
    ipcRenderer.send('dm:unread', count);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  reportUnread();
  new MutationObserver(reportUnread).observe(document.head, {
    subtree: true, childList: true, characterData: true,
  });
});
