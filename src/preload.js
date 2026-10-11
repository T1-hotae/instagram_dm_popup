// Instagram 페이지에 붙는 preload.
// 1) 웹 Notification API를 가로채 메인 프로세스로 보내고 (→ 우측 하단 팝업)
// 2) 탭 제목의 "(N)" 읽지 않음 숫자를 감시한다.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

let clickHandler = null;

contextBridge.exposeInMainWorld('__instaDM', {
  notify: (n) => ipcRenderer.send('dm:notify', n),
  onClick: (cb) => { clickHandler = cb; },
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
