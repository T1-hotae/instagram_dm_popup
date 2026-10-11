// 숨겨진 감시 창(DM 받은편지함)에 붙는 preload.
// Instagram 웹이 브라우저 알림을 보내지 않아도, 대화 목록을 읽어 새 메시지의 이름·내용을 알아낸다.
const { ipcRenderer } = require('electron');

const POLL_MS = 1500;
const seen = new Set();
let seeded = false;
let lastCount = 0;
let pendingCountRise = 0;

// 내가 보낸 메시지 미리보기는 알리지 않는다
const MINE = /^(나|회원님|You)\s*:/;
// 미리보기 끝의 시간 표시 " · 1분", " · 2m", " · 3주" 등 제거
const TIME_SUFFIX = /\s*[·•]\s*[^·•]{1,8}$/;

function isBold(el) {
  const w = parseInt(getComputedStyle(el).fontWeight, 10);
  return w >= 600;
}

function rowCandidates() {
  const links = [...document.querySelectorAll('a[href*="/direct/t/"]')];
  const base = links.length
    ? links
    : [...document.querySelectorAll('[role="listitem"], div[role="button"], [role="link"]')];

  const rows = base.filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.height < 44 || r.height > 120 || r.width < 150) return false;
    if (!el.querySelector('img')) return false;
    const lines = (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    return lines.length >= 2;
  });

  // 서로 포함 관계인 후보는 바깥 것만 남김
  return rows
    .filter((el) => !rows.some((o) => o !== el && o.contains(el)))
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
}

function parseRow(el) {
  const lines = (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const name = lines[0];
  let preview = lines.slice(1).join(' ').replace(TIME_SUFFIX, '').trim();
  // 미리보기 줄이 굵게 표시되면 읽지 않음으로 본다
  const spans = [...el.querySelectorAll('span')].filter((s) => s.childElementCount === 0 && s.textContent.trim());
  const previewSpan = spans.find((s) => s.textContent.trim() && !name.includes(s.textContent.trim()));
  const unread = previewSpan ? isBold(previewSpan) : false;
  const img = el.querySelector('img');
  const href = el.tagName === 'A' ? el.href : (el.querySelector('a[href*="/direct/t/"]') || {}).href;
  return {
    name,
    preview,
    unread,
    icon: img && /^https:/.test(img.src) ? img.src : '',
    url: href || '',
  };
}

function notify(row) {
  ipcRenderer.send('dm:notify', {
    id: 0,
    title: row.name,
    body: row.preview,
    icon: row.icon,
    tag: 'dm:' + row.name,
    url: row.url,
  });
}

function scan() {
  const rows = rowCandidates().slice(0, 15).map(parseRow).filter((r) => r.name && r.preview);
  if (!rows.length) return;

  const fresh = [];
  for (const r of rows) {
    const sig = r.name + '|' + r.preview;
    if (!seen.has(sig)) {
      seen.add(sig);
      if (r.unread && !MINE.test(r.preview)) fresh.push(r);
    }
  }

  if (!seeded) { seeded = true; return; } // 처음 읽은 목록은 알리지 않음

  if (fresh.length) {
    pendingCountRise = 0;
    fresh.slice(0, 3).reverse().forEach(notify);
  } else if (pendingCountRise && Date.now() - pendingCountRise > 2500) {
    // 숫자는 올랐는데 굵은 표시를 못 찾은 경우: 맨 위 대화를 알림
    pendingCountRise = 0;
    const top = rows[0];
    if (top && !MINE.test(top.preview)) notify(top);
  }
}

function watchTitle() {
  const m = /^\((\d+)\)/.exec(document.title || '');
  const count = m ? parseInt(m[1], 10) : 0;
  if (count > lastCount && seeded) pendingCountRise = Date.now();
  lastCount = count;
}

window.addEventListener('DOMContentLoaded', () => {
  setInterval(() => {
    try { watchTitle(); scan(); } catch (e) { /* 페이지 구조가 바뀌어도 앱이 멈추지 않게 */ }
  }, POLL_MS);
});

// 진단용: 대화 목록 구조를 내용 없이(글자 수만) 돌려준다
ipcRenderer.on('watcher:dump', () => {
  const rows = rowCandidates().slice(0, 5).map((el) => {
    const walk = (n, d) => {
      if (d > 12) return '';
      const pad = '  '.repeat(d);
      const attrs = ['role', 'aria-label', 'href', 'alt']
        .filter((a) => n.getAttribute && n.getAttribute(a))
        .map((a) => `${a}="${a === 'aria-label' || a === 'alt' ? n.getAttribute(a).length + 'chars' : n.getAttribute(a).replace(/\d{5,}/g, 'N')}"`)
        .join(' ');
      const fw = n.nodeType === 1 ? getComputedStyle(n).fontWeight : '';
      const txt = n.childElementCount === 0 && n.textContent.trim() ? ` text(${n.textContent.trim().length}) fw=${fw}` : '';
      return `${pad}<${n.tagName.toLowerCase()} ${attrs}>${txt}\n` +
        [...n.children].map((c) => walk(c, d + 1)).join('');
    };
    return walk(el, 0);
  });
  ipcRenderer.send('watcher:dump-result', {
    url: location.href,
    title: document.title.replace(/[^()\d]/g, ''),
    anchors: document.querySelectorAll('a[href*="/direct/t/"]').length,
    rows,
  });
});
