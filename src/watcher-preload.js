// 숨겨진 감시 창(DM 받은편지함)에 붙는 preload.
// 1순위: Instagram 웹이 받은편지함을 그릴 때 쓰는 데이터(direct_v2/inbox)를 같은 로그인 상태로 읽는다.
// 2순위: 데이터 요청이 실패하면 화면의 대화 목록 글자를 읽는다.
const { ipcRenderer, webFrame } = require('electron');

// 숨겨진 창이어도 페이지가 "보이는 상태"로 동작하게 한다 (안 보이면 목록 갱신을 미루는 경우 대비)
webFrame.executeJavaScript(`(() => {
  try {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
  } catch (e) {}
})();`);

const status = (s) => ipcRenderer.send('watcher:status', s);

/* ================= 1순위: 받은편지함 데이터 ================= */

const INBOX_API = '/api/v1/direct_v2/inbox/?persistentBadging=true&folder=&limit=20&thread_message_limit=3';
const API_INTERVAL_MS = 60 * 1000; // 평소 확인 주기
const API_MIN_GAP_MS = 5 * 1000; // 연속 요청 최소 간격

const seenItems = new Set();
let apiSeeded = false;
let apiOkAt = 0;
let apiPausedUntil = 0;
let lastApiAt = 0;
let checkTimer = null;

async function fetchInbox() {
  const csrf = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || '';
  const res = await fetch(INBOX_API, {
    credentials: 'include',
    headers: {
      'X-IG-App-ID': '936619743392459',
      'X-CSRFToken': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'X-IG-WWW-Claim': sessionStorage.getItem('www-claim-v2') || '0',
    },
  });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.httpStatus = res.status;
    throw err;
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('응답이 JSON이 아님 (로그인 필요?)');
    err.httpStatus = res.status;
    throw err;
  }
}

function describe(item) {
  const t = item.item_type;
  if (t === 'text') return item.text || '';
  if (t === 'link') return (item.link && item.link.text) || '링크를 보냈습니다.';
  if (t === 'like') return '❤️';
  if (t === 'reel_share') {
    const txt = item.reel_share && item.reel_share.text;
    return txt ? `스토리에 답장: ${txt}` : '스토리에 반응했습니다.';
  }
  if (t === 'voice_media') return '음성 메시지를 보냈습니다.';
  if (t === 'animated_media') return 'GIF를 보냈습니다.';
  if (t === 'media' || t === 'raven_media' || t === 'visual_media') return '사진 또는 동영상을 보냈습니다.';
  if (/story/.test(t)) return '스토리를 공유했습니다.';
  if (/media_share|clip|xma/.test(t)) return '게시물을 공유했습니다.';
  return '새 메시지를 보냈습니다.';
}

// 받은편지함 데이터에서 아직 알리지 않은 상대방 메시지를 찾는다 (대화방마다 가장 최근 것만)
function processInbox(json) {
  const viewerId = String((json.viewer && (json.viewer.pk || json.viewer.pk_id || json.viewer.id)) || '');
  const threads = (json.inbox && json.inbox.threads) || [];
  const newest = new Map();

  for (const t of threads) {
    const lastSeen = Number((t.last_seen_at && t.last_seen_at[viewerId] && t.last_seen_at[viewerId].timestamp) || 0);
    for (const it of t.items || []) {
      if (!it.item_id || seenItems.has(it.item_id)) continue;
      seenItems.add(it.item_id);
      if (!apiSeeded) continue; // 처음 읽은 내용은 알리지 않음
      if (String(it.user_id) === viewerId) continue; // 내가 보낸 것
      if (lastSeen && Number(it.timestamp) <= lastSeen) continue; // 이미 읽은 것
      const prev = newest.get(t.thread_id);
      if (!prev || Number(it.timestamp) > Number(prev.it.timestamp)) newest.set(t.thread_id, { t, it });
    }
  }
  apiSeeded = true;

  [...newest.values()]
    .sort((a, b) => Number(a.it.timestamp) - Number(b.it.timestamp))
    .slice(-3)
    .forEach(({ t, it }) => {
      const sender = (t.users || []).find((u) => String(u.pk || u.pk_id) === String(it.user_id)) || {};
      const senderName = sender.full_name || sender.username || 'Instagram';
      const isGroup = t.is_group || (t.users || []).length > 1;
      ipcRenderer.send('dm:notify', {
        id: 0,
        title: isGroup ? (t.thread_title || senderName) : senderName,
        body: isGroup ? `${senderName}: ${describe(it)}` : describe(it),
        icon: sender.profile_pic_url || '',
        tag: 'thread:' + t.thread_id,
        url: `https://www.instagram.com/direct/t/${t.thread_id}/`,
        source: 'api',
      });
    });

  return { threads: threads.length, viewerFound: !!viewerId };
}

async function checkInbox(reason) {
  const now = Date.now();
  if (now < apiPausedUntil) return;
  if (now - lastApiAt < API_MIN_GAP_MS) return;
  lastApiAt = now;
  try {
    const json = await fetchInbox();
    const r = processInbox(json);
    apiOkAt = Date.now();
    status({ source: 'api', ok: true, reason, threads: r.threads, viewerFound: r.viewerFound });
  } catch (e) {
    // 401/403/429는 요청을 잠시 멈춘다 (계정 보호)
    if ([401, 403, 429].includes(e.httpStatus)) apiPausedUntil = Date.now() + 10 * 60 * 1000;
    status({ source: 'api', ok: false, reason, httpStatus: e.httpStatus || 0, error: e.message });
  }
}

function scheduleCheck(reason, delay = 800) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => checkInbox(reason), delay);
}

const apiHealthy = () => Date.now() - apiOkAt < 3 * 60 * 1000;

ipcRenderer.on('watcher:check', () => scheduleCheck('unread', 500));

/* ================= 2순위: 화면 목록 읽기 ================= */

const seenRows = new Set();
let domSeeded = false;
let lastCount = 0;
let pendingCountRise = 0;

const MINE = /^(나|회원님|You)\s*:/; // 내가 보낸 메시지
const TIME_SUFFIX = /\s*[·•]\s*[^·•]{1,8}$/; // " · 1분" 같은 시간 표시

function rowCandidates() {
  const links = [...document.querySelectorAll('a[href*="/direct/t/"]')];
  const base = links.length
    ? links
    : [...document.querySelectorAll('[role="listitem"], div[role="button"], [role="link"]')];
  const rows = base.filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.height < 44 || r.height > 120 || r.width < 150) return false;
    if (!el.querySelector('img')) return false;
    return (el.innerText || '').split('\n').filter((s) => s.trim()).length >= 2;
  });
  return rows
    .filter((el) => !rows.some((o) => o !== el && o.contains(el)))
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
}

function parseRow(el) {
  const lines = (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const name = lines[0];
  const preview = lines.slice(1).join(' ').replace(TIME_SUFFIX, '').trim();
  const spans = [...el.querySelectorAll('span')].filter((s) => s.childElementCount === 0 && s.textContent.trim());
  const previewSpan = spans.find((s) => !name.includes(s.textContent.trim()));
  const unread = previewSpan ? parseInt(getComputedStyle(previewSpan).fontWeight, 10) >= 600 : false;
  const img = el.querySelector('img');
  const href = el.tagName === 'A' ? el.href : (el.querySelector('a[href*="/direct/t/"]') || {}).href;
  return { name, preview, unread, icon: img && /^https:/.test(img.src) ? img.src : '', url: href || '' };
}

function domNotify(row) {
  ipcRenderer.send('dm:notify', {
    id: 0, title: row.name, body: row.preview, icon: row.icon,
    tag: 'dm:' + row.name, url: row.url, source: 'dom',
  });
}

let lastDomStatusAt = 0;
function scanDom() {
  const m = /^\((\d+)\)/.exec(document.title || '');
  const count = m ? parseInt(m[1], 10) : 0;
  if (count > lastCount) {
    scheduleCheck('title'); // 숫자가 오르면 받은편지함 데이터를 바로 확인
    if (domSeeded) pendingCountRise = Date.now();
  }
  lastCount = count;

  const rows = rowCandidates().slice(0, 15).map(parseRow).filter((r) => r.name && r.preview);

  if (Date.now() - lastDomStatusAt > 30000) {
    lastDomStatusAt = Date.now();
    status({ source: 'dom', path: location.pathname, titleCount: count, rows: rows.length,
      unreadRows: rows.filter((r) => r.unread).length, hidden: document.hidden });
  }
  if (!rows.length) return;

  const fresh = [];
  for (const r of rows) {
    const sig = r.name + '|' + r.preview;
    if (!seenRows.has(sig)) {
      seenRows.add(sig);
      if (r.unread && !MINE.test(r.preview)) fresh.push(r);
    }
  }
  if (!domSeeded) { domSeeded = true; return; }
  if (apiHealthy()) { pendingCountRise = 0; return; } // 데이터 방식이 잘 되면 화면 읽기는 알리지 않음

  if (fresh.length) {
    pendingCountRise = 0;
    fresh.slice(0, 3).reverse().forEach(domNotify);
  } else if (pendingCountRise && Date.now() - pendingCountRise > 2500) {
    pendingCountRise = 0;
    const top = rows[0];
    if (top && !MINE.test(top.preview)) domNotify(top);
  }
}

/* ================= 시작 ================= */

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => checkInbox('start'), 4000);
  setInterval(() => checkInbox('interval'), API_INTERVAL_MS);
  setInterval(() => { try { scanDom(); } catch (e) { /* 구조가 바뀌어도 멈추지 않게 */ } }, 1500);
});

/* ================= 점검·진단 (메시지 내용은 보내지 않음) ================= */

ipcRenderer.on('watcher:selftest', async () => {
  const result = { path: location.pathname, hidden: document.hidden };
  try {
    const json = await fetchInbox();
    const threads = (json.inbox && json.inbox.threads) || [];
    const first = threads[0] || {};
    const item = (first.items || [])[0] || {};
    const user = (first.users || [])[0] || {};
    result.api = {
      ok: true,
      threads: threads.length,
      hasText: !!item.item_type,
      hasName: !!(user.full_name || user.username),
      samplePic: user.profile_pic_url || '',
    };
  } catch (e) {
    result.api = { ok: false, httpStatus: e.httpStatus || 0, error: e.message };
  }
  const rows = rowCandidates().map(parseRow);
  result.dom = { rows: rows.length, withPreview: rows.filter((r) => r.preview).length };
  ipcRenderer.send('watcher:selftest-result', result);
});

ipcRenderer.on('watcher:dump', () => {
  const rows = rowCandidates().slice(0, 5).map((el) => {
    const walk = (n, d) => {
      if (d > 12) return '';
      const attrs = ['role', 'aria-label', 'href', 'alt']
        .filter((a) => n.getAttribute && n.getAttribute(a))
        .map((a) => `${a}="${a === 'aria-label' || a === 'alt' ? n.getAttribute(a).length + 'chars' : n.getAttribute(a).replace(/\d{5,}/g, 'N')}"`)
        .join(' ');
      const fw = n.nodeType === 1 ? getComputedStyle(n).fontWeight : '';
      const txt = n.childElementCount === 0 && n.textContent.trim() ? ` text(${n.textContent.trim().length}) fw=${fw}` : '';
      return `${'  '.repeat(d)}<${n.tagName.toLowerCase()} ${attrs}>${txt}\n` +
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
