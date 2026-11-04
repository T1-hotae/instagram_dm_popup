// 메인 프로세스. 창·트레이·팝업·설정·로그와 모든 IPC를 여기서 다룬다.
// 창은 넷이고, 각자 src/<창>/ 폴더에 화면과 preload가 있다.
//   메인 창  = titlebar/(타이틀바) + instagram/(그 아래 Instagram 화면, igView)
//   감시 창  = watcher/ (숨은 받은편지함, 새 DM 감지)
//   팝업     = popup/   (오른쪽 아래 알림)
//   채팅 창  = chat/    (대화 하나만 띄운 창, 대화마다 하나)
// 전체 그림은 docs/[00] 구조.md, 쓰인 기술과 원리는 docs/[03] 기술과 원리.md에 있다.
const {
  app, BrowserWindow, WebContentsView, Tray, Menu, ipcMain, screen, shell, nativeImage, nativeTheme, session, dialog, powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');

const INBOX_URL = 'https://www.instagram.com/direct/inbox/';
// igView, 감시 창, 로그인 창은 모두 partition 'persist:instagram'을 쓴다.
// 쿠키를 함께 쓰므로 메인 창에서 한 번 로그인하면 감시 창도 로그인된 상태가 된다.
const ASSETS = path.join(__dirname, '..', 'assets');
const START_HIDDEN = process.argv.includes('--hidden');

// Electron 표기가 붙은 UA는 Instagram이 "지원하지 않는 브라우저"로 막을 수 있어 일반 Chrome UA로 맞춘다.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s?Electron\/\S+/, '')
  .replace(/\s?insta-dm\/\S+/i, '');

// 한 번에 하나만 실행. 두 번째로 띄우면 바로 끝나고 기존 창이 앞으로 나온다(second-instance).
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/* ---------------- 설정 ---------------- */

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const defaults = { notify: true, sound: true, preview: true, chatWindow: true };
let settings = { ...defaults };

function loadSettings() {
  try {
    settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    settings = { ...defaults };
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('settings save failed', e);
  }
}

/* ---------------- 로그 (메시지 내용은 기록하지 않음) ---------------- */

const logPath = () => path.join(app.getPath('userData'), 'insta-dm.log');

function log(...parts) {
  const line = `[${new Date().toLocaleString('ko-KR')}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try {
    const file = logPath();
    if (fs.existsSync(file) && fs.statSync(file).size > 300 * 1024) {
      const keep = fs.readFileSync(file, 'utf8').slice(-150 * 1024);
      fs.writeFileSync(file, keep);
    }
    fs.appendFileSync(file, line);
  } catch {
    // 로그 실패는 무시
  }
}

/* ---------------- 프로필 사진 ---------------- */

// 팝업이 Instagram 이미지 서버에서 직접 받으면 막힐 수 있어서, 로그인 세션으로 먼저 받아 data URL로 넘긴다.
const avatarCache = new Map();

async function resolveAvatar(url) {
  if (!/^https:\/\//.test(url || '')) return '';
  if (avatarCache.has(url)) return avatarCache.get(url);
  try {
    const ses = session.fromPartition('persist:instagram');
    const res = await Promise.race([
      ses.fetch(url, { headers: { Referer: 'https://www.instagram.com/' } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) throw new Error(`HTTP ${res.status} ${type}`);
    const data = `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    if (avatarCache.size > 100) avatarCache.delete(avatarCache.keys().next().value);
    avatarCache.set(url, data);
    return data;
  } catch (e) {
    log('avatar 실패', e.message);
    return '';
  }
}

/* ---------------- 메인 창 ---------------- */

// 창은 테두리 없이 만들고 위쪽 36px에 직접 그린 타이틀바(titlebar.html)를,
// 그 아래에 Instagram 화면(igView)을 붙인다.
const TITLEBAR_H = 36;

let mainWindow = null;
let igView = null;
let tray = null;
let quitting = false;
let unread = 0; // 탭 제목 (N) 숫자 (좋아요 등 다른 알림이 섞임)
let apiUnread = null; // 받은편지함 데이터로 센 읽지 않은 대화 수 (DM만)
let apiOkAt = 0;
let pageTheme = ''; // Instagram 화면이 다크/라이트 중 무엇인지
let avatarClickAt = 0;

const apiHealthy = () => Date.now() - apiOkAt < 3 * 60 * 1000;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    title: 'InstaDM',
    icon: path.join(ASSETS, 'icon.png'),
    show: false,
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'titlebar', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'titlebar', 'titlebar.html'));

  igView = new WebContentsView({
    webPreferences: {
      partition: 'persist:instagram', // 로그인 유지
      preload: path.join(__dirname, 'instagram', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false, // 숨김·최소화 중 멈춘 타이머·그리기 때문에 메시지가 안 그려지는 것을 막는다
    },
  });
  mainWindow.contentView.addChildView(igView);
  const layoutView = () => {
    const [width, height] = mainWindow.getContentSize();
    igView.setBounds({ x: 0, y: TITLEBAR_H, width, height: Math.max(0, height - TITLEBAR_H) });
  };
  layoutView();
  mainWindow.on('resize', layoutView);

  const wc = igView.webContents;
  wc.loadURL(INBOX_URL);

  // 숨김→표시, 최소화→복원 뒤 igView가 흰 화면으로 남는 경우가 있어 다시 배치하고 다시 그린다
  ['show', 'restore', 'maximize', 'unmaximize'].forEach((ev) => mainWindow.on(ev, () => {
    layoutView();
    wc.invalidate();
    if (ev === 'show') {
      const b = igView.getBounds();
      wc.executeJavaScript('document.visibilityState').catch(() => '?')
        .then((v) => log('메인 표시', `${b.x},${b.y} ${b.width}x${b.height}`, v));
    }
  }));

  // 렌더러가 죽거나 불러오기에 실패하면 흰 화면이 되므로 다시 불러온다
  wc.on('render-process-gone', (_e, d) => {
    log('메인 렌더러 종료', d.reason, d.exitCode);
    setTimeout(() => !wc.isDestroyed() && wc.reload(), 1000);
  });
  wc.on('unresponsive', () => log('메인 응답 없음'));
  wc.on('responsive', () => log('메인 응답 회복'));
  wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: 이동 중 취소, 정상
    log('메인 불러오기 실패', code);
    setTimeout(() => !wc.isDestroyed() && wc.reload(), 30000); // 오프라인이면 계속 실패하므로 간격을 넉넉히
  });

  mainWindow.once('ready-to-show', () => {
    if (!START_HIDDEN) {
      mainWindow.show();
      wc.focus();
    }
  });

  // X 버튼은 종료가 아니라 트레이로 숨기기 (카카오톡과 동일)
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('focus', () => {
    mainWindow.flashFrame(false);
    sendTitlebarState();
  });
  ['blur', 'maximize', 'unmaximize'].forEach((ev) => mainWindow.on(ev, sendTitlebarState));
  mainWindow.webContents.on('did-finish-load', sendTitlebarState);

  let lastMainUrl = '';
  const onMainNavigate = (_e, url) => {
    if (lastMainUrl.includes('/accounts/') && !url.includes('/accounts/')) reloadWatcherSoon();
    lastMainUrl = url;
    const p = new URL(url).pathname;
    if (/^\/(accounts|challenge|direct)/.test(p)) log('메인 이동', p.replace(/\/t\/[^/]+/, '/t/ID'));
    // 받은편지함 사진 클릭을 막지 못해 스토리가 열렸으면 되돌린다
    if (p.startsWith('/stories/') && Date.now() - avatarClickAt < 1500) {
      avatarClickAt = 0;
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    }
    // 대화를 열면 채팅 창으로 넘기고 메인 창은 받은편지함으로 되돌린다.
    // goBack은 주소만 돌아가고 Instagram 안에서는 그 대화가 선택된 채로 남아, 같은 사람을 다시 눌러도 이동하지 않았다. 그래서 새로 불러온다.
    if (settings.chatWindow && openChat(url)) wc.loadURL(INBOX_URL);
    syncTheme();
  };
  wc.on('did-navigate', onMainNavigate);
  wc.on('did-navigate-in-page', onMainNavigate);
  wc.on('did-finish-load', syncTheme);

  guardLinks(wc, mainWindow, (url) => wc.loadURL(url));
  bindKeys(wc, () => mainWindow.close()); // Ctrl+W: X 버튼과 같이 트레이로 숨김

  setInterval(() => mainWindow.isVisible() && syncTheme(), 5000);
}

// 새 창 요청: 페이스북·Meta 로그인은 앱 안 작은 창에서 (같은 세션이라 로그인이 반영됨),
// Instagram 안의 링크는 openInstagram으로, 외부 링크는 기본 브라우저로
function guardLinks(wc, parent, openInstagram) {
  wc.setWindowOpenHandler(({ url }) => {
    if (isMetaLogin(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent,
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          title: '로그인',
          webPreferences: { partition: 'persist:instagram', contextIsolation: true, sandbox: true },
        },
      };
    }
    if (isInstagram(url)) openInstagram(url);
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (e, url) => {
    if (!isInstagram(url) && !isMetaLogin(url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
}

// 메뉴바가 없어서 단축키를 직접 처리. close = Ctrl+W 때 할 일
function bindKeys(wc, close) {
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.control) return;
    const key = input.key.toLowerCase();
    if (key === 'r') wc.reload();
    else if (key === 'w') close();
    else if (key === '=' || key === '+') zoom(0.5, wc);
    else if (key === '-') zoom(-0.5, wc);
    else if (key === '0') zoom(0, wc);
    else if (key === 'i' && input.shift) wc.openDevTools({ mode: 'detach' });
    else return;
    e.preventDefault();
  });
}

function zoom(step, wc = igView && igView.webContents) {
  if (!wc) return;
  wc.setZoomLevel(step ? wc.getZoomLevel() + step : 0);
}

// Instagram 화면 배경이 어두운지 보고 타이틀바 색을 맞춘다
async function syncTheme() {
  if (!igView) return;
  try {
    const dark = await igView.webContents.executeJavaScript(`(() => {
      const cl = document.documentElement.classList;
      if (cl.contains('__fb-dark-mode')) return true;
      if (cl.contains('__fb-light-mode')) return false;
      const m = getComputedStyle(document.body).backgroundColor.match(/[\\d.]+/g);
      if (!m || (m.length > 3 && Number(m[3]) === 0)) return null;
      return (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 < 128;
    })()`);
    const theme = dark === null ? '' : dark ? 'dark' : 'light';
    if (theme !== pageTheme) {
      pageTheme = theme;
      if (theme) mainWindow.setBackgroundColor(theme === 'dark' ? '#000000' : '#ffffff');
      sendTitlebarState();
    }
  } catch {
    // 페이지가 아직 준비되지 않음
  }
}

function sendTitlebarState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('titlebar:state', {
    unread: badgeCount(),
    maximized: mainWindow.isMaximized(),
    focused: mainWindow.isFocused(),
    theme: pageTheme,
  });
}

ipcMain.on('titlebar:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('titlebar:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('titlebar:close', () => mainWindow && mainWindow.close());
ipcMain.on('titlebar:menu', (_e, pos) => {
  if (!mainWindow) return;
  Menu.buildFromTemplate(menuTemplate()).popup({
    window: mainWindow,
    x: Math.round(Number(pos && pos.x) || 0),
    y: Math.round(Number(pos && pos.y) || TITLEBAR_H),
  });
});

// 화면에 보이지 않는 감시 창: 항상 DM 받은편지함을 띄워 두고 새 메시지 내용을 읽는다.
// 가로 폭을 넓게 잡아야 대화 목록이 보이는 데스크톱 화면 구성이 나온다.
let watcherWindow = null;
let watcherRetryTimer = null;

function createWatcherWindow() {
  watcherWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      partition: 'persist:instagram',
      preload: path.join(__dirname, 'watcher', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // 숨겨진 창에서도 주기적으로 확인
    },
  });
  watcherWindow.webContents.setAudioMuted(true);
  watcherWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  watcherWindow.loadURL(INBOX_URL);

  // 받은편지함을 벗어나면 잠시 뒤 다시 받은편지함으로.
  // 로그인 화면이면 다시 불러오지 않고 메인 창 로그인이 끝나길 기다린다 (reloadWatcherSoon).
  watcherWindow.webContents.on('did-navigate', (_e, url) => {
    const p = new URL(url).pathname;
    log('감시 창 이동', p);
    clearTimeout(watcherRetryTimer);
    if (!url.startsWith(INBOX_URL) && !p.startsWith('/accounts/') && !p.startsWith('/challenge')) {
      watcherRetryTimer = setTimeout(() => watcherWindow && !watcherWindow.isDestroyed() && watcherWindow.loadURL(INBOX_URL), 60000);
    }
  });
  // 팝업 클릭으로 감시 창이 대화 줄을 눌렀으면(watcher:open) 그 대화를 채팅 창으로 열고 감시 창은 받은편지함으로 돌린다
  watcherWindow.webContents.on('did-navigate-in-page', (_e, url) => {
    if (!pendingOpen || !threadIdOf(url)) return;
    openChat(url);
    const wc = watcherWindow.webContents;
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else wc.loadURL(INBOX_URL);
  });

  // 메모리 누수 방지를 위해 3시간마다 새로고침
  setInterval(() => watcherWindow && !watcherWindow.isDestroyed() && watcherWindow.loadURL(INBOX_URL), 3 * 60 * 60 * 1000);

  watcherWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      watcherWindow.hide();
      refreshMenus();
    }
  });
}

// 알림 경로 점검: 데이터 요청·화면 읽기·프로필 사진을 각각 확인해서 결과만 보여 준다
ipcMain.on('watcher:selftest-result', async (_e, r) => {
  const avatarOk = r.api && r.api.samplePic ? !!(await resolveAvatar(r.api.samplePic)) : false;
  const ox = (v) => (v ? '○' : '×');
  const lines = [
    `감시 창 위치: ${r.path}${r.path.startsWith('/direct') ? '' : '  ← 받은편지함이 아님 (로그인 필요?)'}`,
    '',
    `[1순위] 받은편지함 데이터: ${r.api.ok ? '성공' : `실패 (${r.api.error})`}`,
    ...(r.api.ok ? [
      `   대화 ${r.api.threads}개 · 내용 ${ox(r.api.hasText)} · 이름 ${ox(r.api.hasName)} · 프로필 사진 ${ox(avatarOk)}`,
    ] : []),
    `[2순위] 화면 목록 읽기: 대화 줄 ${r.dom.rows}개 (미리보기 있는 줄 ${r.dom.withPreview}개)`,
    '',
    r.api.ok
      ? '새 DM이 오면 이름·내용·프로필 사진이 팝업에 나옵니다.'
      : r.dom.withPreview
        ? '데이터 요청은 실패했지만 화면 읽기로 이름·내용을 알릴 수 있습니다.'
        : '두 방법 모두 실패했습니다. "감시 창 보기"로 화면을 확인해 주세요.',
  ];
  log('점검', { path: r.path, api: { ...r.api, samplePic: !!(r.api && r.api.samplePic) }, dom: r.dom, avatarOk });
  dialog.showMessageBox({ type: 'info', title: 'InstaDM 알림 경로 점검', message: '알림 경로 점검 결과', detail: lines.join('\n') });
});

// 메인 창에서 로그인하면 감시 창도 로그인 상태로 다시 연다
function reloadWatcherSoon() {
  clearTimeout(watcherRetryTimer);
  watcherRetryTimer = setTimeout(() => watcherWindow && !watcherWindow.isDestroyed() && watcherWindow.loadURL(INBOX_URL), 3000);
}

function isInstagram(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'instagram.com' || h.endsWith('.instagram.com');
  } catch {
    return false;
  }
}

// 페이스북·Meta 계정 로그인과 2단계 인증 흐름은 창 안에서 허용
function isMetaLogin(url) {
  try {
    const h = new URL(url).hostname;
    return h.endsWith('facebook.com') || h.endsWith('accountscenter.instagram.com')
      || h === 'meta.com' || h.endsWith('.meta.com') || h.endsWith('fbcdn.net');
  } catch {
    return false;
  }
}

function showMain(url) {
  if (!mainWindow) return;
  if (url && isInstagram(url)) igView.webContents.loadURL(url);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  igView.webContents.focus();
}

/* ---------------- 채팅 창 (대화 하나만, 카카오톡 대화창처럼) ---------------- */

// 창마다 Instagram 페이지가 통째로 떠서(약 200MB) 개수를 제한한다. 넘치면 가장 먼저 연 창을 닫는다.
const MAX_CHATS = 4;
const chatWindows = new Map(); // thread id → 창
let warmChat = null; // 받은편지함을 미리 불러 둔 숨은 채팅 창. 열 때 페이지를 처음부터 받는 시간을 줄인다
let pendingOpen = 0; // 팝업 클릭으로 대화를 찾는 중이면 마감 시각 (openChat이 열면 0)

function threadIdOf(url) {
  try {
    const m = /^\/direct\/t\/([\w.-]+)/.exec(new URL(url).pathname);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

const threadUrl = (id) => `https://www.instagram.com/direct/t/${id}/`;
const isChatContents = (wc) => [...chatWindows.values(), warmChat]
  .some((w) => w && !w.isDestroyed() && w.webContents === wc);

// 대화 주소면 채팅 창을 열고(이미 있으면 앞으로) true, 아니면 false
function openChat(url) {
  const id = threadIdOf(url);
  if (!id) return false;
  pendingOpen = 0;
  const open = chatWindows.get(id);
  if (open && !open.isDestroyed()) {
    // 대화로 못 옮겨 가고 받은편지함에 멈춘 창이면 앞으로만 가져와서는 안 열린 것처럼 보인다
    if (!threadIdOf(open.webContents.getURL())) open.webContents.loadURL(threadUrl(id));
    if (open.isMinimized()) open.restore();
    open.show();
    open.moveTop();
    open.focus();
    log('채팅 창 앞으로', { visible: open.isVisible() });
    return true;
  }
  while (chatWindows.size >= MAX_CHATS) {
    const [oldId, w] = chatWindows.entries().next().value;
    chatWindows.delete(oldId);
    if (!w.isDestroyed()) w.destroy();
  }
  const warm = takeWarmChat(id);
  chatWindows.set(id, warm || createChatWindow(threadUrl(id), id));
  log('채팅 창 열기', { open: chatWindows.size, warm: !!warm });
  setTimeout(prepareWarmChat, 5000); // 다음 대화를 위해 하나 더 준비
  return true;
}

// 숨은 채팅 창 하나를 받은편지함으로 불러 둔다 (설정이 켜져 있을 때만, 하나만)
function prepareWarmChat() {
  if (!settings.chatWindow || (warmChat && !warmChat.isDestroyed())) return;
  const win = createChatWindow(INBOX_URL, '');
  warmChat = win;
  win.webContents.once('did-finish-load', () => { win.ready = true; });
}

// 미리 띄운 창을 그 대화로 옮긴다. 렌더러와 창은 이미 떠 있어서 새 창보다 빠르다.
// popstate로 페이지 안에서만 옮기던 방식은 주소만 바뀌고 화면은 받은편지함에 남아서(11-04 로그) 그냥 불러온다.
function takeWarmChat(id) {
  const win = warmChat;
  if (!win || win.isDestroyed() || !win.ready) return null;
  warmChat = null;
  win.chatId = id;
  win.setSkipTaskbar(false);
  const wc = win.webContents;
  wc.loadURL(threadUrl(id));
  // 받은편지함이 잠깐 비치지 않게 화면이 바뀔 틈을 주고 띄운다
  setTimeout(() => {
    if (win.isDestroyed()) return;
    win.show();
    wc.focus();
  }, 200);
  return win;
}

// 채팅 창 하나 만들기. win.chatId가 비어 있으면 아직 대화가 정해지지 않은 미리 띄운 창
function createChatWindow(loadUrl, chatId) {
  const win = new BrowserWindow({
    width: 500,
    height: 800,
    minWidth: 320,
    minHeight: 400,
    title: 'InstaDM',
    icon: path.join(ASSETS, 'icon.png'),
    show: false,
    skipTaskbar: !chatId,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff',
    webPreferences: {
      partition: 'persist:instagram',
      preload: path.join(__dirname, 'chat', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.chatId = chatId;
  win.on('show', () => {
    win.shownAt = Date.now();
    log('채팅 창 표시');
  });
  win.on('closed', () => {
    if (chatWindows.get(win.chatId) === win) chatWindows.delete(win.chatId);
    if (warmChat === win) warmChat = null;
  });

  const wc = win.webContents;
  wc.loadURL(loadUrl);
  const showChat = () => {
    if (!win.chatId || win.isDestroyed() || win.isVisible()) return; // 미리 띄운 창은 takeWarmChat이 띄운다
    win.show();
    wc.focus();
  };
  win.once('ready-to-show', showChat);
  if (chatId) setTimeout(showChat, 3000); // ready-to-show가 안 와도 창이 숨은 채 남지 않게

  // 포커스가 없으면 페이지에 숨겨진 것으로 알려 읽음 처리를 막는다 (chat/preload.js)
  const setActive = () => !wc.isDestroyed() && wc.send('chat:active', win.isFocused());
  win.on('focus', setActive);
  win.on('blur', setActive);
  wc.on('did-finish-load', setActive); // 새로고침하면 preload가 처음 상태(보임)로 돌아가므로 다시 알린다

  // 이 대화 밖으로 나가는 이동(프로필 등)은 메인 창에서 열고 채팅 창은 대화에 남긴다.
  // 받은편지함으로 가는 것(모바일 화면의 ← 버튼)은 창 닫기로 본다.
  const onNavigate = (_e, navUrl) => {
    if (!win.chatId) return; // 미리 띄운 창은 받은편지함에 머문다
    const p = new URL(navUrl).pathname;
    const tid = threadIdOf(navUrl);
    if (tid) {
      // Instagram이 주소의 id를 바꿔 쓰는 경우도 같은 창으로 찾을 수 있게 다시 등록
      if (tid !== win.chatId && !chatWindows.has(tid)) {
        if (chatWindows.get(win.chatId) === win) chatWindows.delete(win.chatId);
        win.chatId = tid;
        chatWindows.set(tid, win);
      }
      return;
    }
    log('채팅 창 이동', p.replace(/\/t\/[^/]+/, '/t/ID'));
    if (p.startsWith('/accounts/') || p.startsWith('/challenge')) return;
    if (p.startsWith('/direct/inbox')) {
      // 막 열린 창이 받은편지함을 거쳐 가는 경우가 있어(로그상 창이 뜨기도 전에 닫힘) 그때는 대화를 한 번 다시 불러온다.
      // 창이 떠서 3초 넘게 지난 뒤의 받은편지함 이동만 ← 버튼으로 보고 닫는다.
      if (!win.shownAt || Date.now() - win.shownAt < 3000) {
        if (!win.retried) {
          win.retried = true;
          wc.loadURL(threadUrl(win.chatId));
        }
        return;
      }
      win.close();
      return;
    }
    showMain(navUrl);
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else win.close();
  };
  wc.on('did-navigate', onNavigate);
  wc.on('did-navigate-in-page', onNavigate);
  wc.on('render-process-gone', (_e, d) => {
    log('채팅 렌더러 종료', d.reason, d.exitCode);
    if (!win.isDestroyed()) win.destroy();
  });

  guardLinks(wc, win, (u) => (openChat(u) ? null : showMain(u)));
  bindKeys(wc, () => win.close());
  return win;
}

// 팝업 클릭: 그 사람 채팅 창을 바로 연다.
// 주소가 있으면 바로 열고, 페이지 알림이면 onclick으로 Instagram이 대화로 이동하게 한다(onMainNavigate가 채팅 창으로 넘김).
// 화면 읽기 알림처럼 주소가 없으면 감시 창이 목록에서 그 이름 줄을 찾는다. 3초 안에 못 열면 메인 창을 연다.
function openFromPopup(d) {
  if (!settings.chatWindow) {
    if (d.id && igView) {
      igView.webContents.send('dm:click', d.id); // 페이지가 등록한 알림 onclick → 그 대화로 이동
      return showMain();
    }
    return showMain(d.url || INBOX_URL);
  }
  if (openChat(d.url)) return;
  if (d.id && igView) igView.webContents.send('dm:click', d.id);
  else if (d.tag.startsWith('dm:') && watcherWindow && !watcherWindow.isDestroyed()) {
    watcherWindow.webContents.send('watcher:open', d.tag.slice(3));
  } else return showMain(INBOX_URL);
  const deadline = Date.now() + 3000;
  pendingOpen = deadline;
  setTimeout(() => {
    if (pendingOpen !== deadline) return;
    pendingOpen = 0;
    log('팝업 대화 찾기 실패');
    showMain();
  }, 3000);
}

// 감시 창이 이름으로 찾은 대화 주소 ('' = 못 찾음)
ipcMain.on('watcher:open-result', (_e, url) => {
  if (pendingOpen && !openChat(url)) {
    pendingOpen = 0;
    log('팝업 대화 찾기 실패');
    showMain();
  }
});

// 채팅 창에서 Esc (대화 상자가 없을 때)
ipcMain.on('chat:close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && isChatContents(e.sender)) win.close();
});

/* ---------------- 우측 하단 팝업 알림 ---------------- */

const POPUP_W = 360;
const POPUP_H = 104;
const POPUP_GAP = 4;
const MAX_POPUPS = 4;
const popups = [];
const recentKeys = new Map(); // '제목|내용' → 보낸 곳(source)

function layoutPopups() {
  const { workArea } = screen.getPrimaryDisplay();
  popups.forEach((p, i) => {
    if (p.win.isDestroyed()) return;
    p.win.setBounds({
      x: workArea.x + workArea.width - POPUP_W - 8,
      y: workArea.y + workArea.height - (POPUP_H + POPUP_GAP) * (i + 1) - 4,
      width: POPUP_W,
      height: POPUP_H,
    });
  });
}

function closePopup(win) {
  const i = popups.findIndex((p) => p.win === win);
  if (i >= 0) popups.splice(i, 1);
  if (!win.isDestroyed()) win.destroy();
  layoutPopups();
}

// 팝업에 넘길 내용. msg = 마지막 메시지('' 이면 아직 입력 중만), typing = 입력 중 표시, sound = 이번에 소리 낼지
function popupPayload(p, sound) {
  return {
    title: p.data.title,
    icon: p.data.icon,
    msg: p.msg && !settings.preview ? '새 메시지가 도착했습니다.' : p.msg,
    typing: p.typing,
    typingText: p.typingText,
    sound: sound && settings.sound,
  };
}

function sendPopup(p, sound) {
  if (p.win.isDestroyed()) return;
  const keepSound = !p.loaded && p.pending && p.pending.sound; // 불러오기 전에 덮여도 소리는 남긴다
  p.pending = popupPayload(p, sound || keepSound);
  if (p.loaded) p.win.webContents.send('popup:update', p.pending);
}

// data.kind: 'msg'(기본) | 'typing' | 'typing-stop'. 같은 대화(tag)의 팝업은 창을 새로 만들지 않고 내용만 바꾼다.
function showPopup(data) {
  const kind = data.kind || 'msg';
  const same = data.tag ? popups.find((p) => p.data.tag === data.tag && !p.win.isDestroyed()) : null;
  if (kind === 'typing-stop') {
    if (same && same.typing) {
      same.typing = false;
      if (!same.msg) return closePopup(same.win); // 입력만 하다 멈춤: 보여 줄 메시지가 없다
      sendPopup(same, false);
    }
    return;
  }
  if (!settings.notify) return log('팝업 생략', { reason: 'off' });
  // 창을 보고 있는 중이면 팝업을 띄우지 않는다
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) return log('팝업 생략', { reason: 'focus' });
  // 그 대화의 채팅 창을 보고 있어도 띄우지 않는다 (화면 읽기 알림은 주소가 없을 수 있어 그때는 띄움)
  const chat = [...chatWindows.entries()].find(([, w]) => !w.isDestroyed() && w.isFocused());
  if (chat && `${data.tag} ${data.url}`.includes(chat[0])) return log('팝업 생략', { reason: 'chat-focus' });

  if (same) {
    if (kind === 'typing') {
      same.typing = true;
      same.typingText = data.body;
    } else {
      same.msg = data.body;
      same.typing = false;
    }
    if (data.icon) same.data.icon = data.icon;
    log('팝업 갱신', { kind });
    return sendPopup(same, kind === 'msg');
  }

  // 페이지 알림과 감시 창이 같은 메시지를 동시에 알린 경우 한 번만 띄운다.
  // 화면 읽기(dom)끼리는 감시 창이 이미 "바뀐 것만" 보내므로 막지 않는다(입력 중 → 메시지 → 입력 중이 10초 안에 와도 뜨게).
  const key = data.title + '|' + data.body;
  const prev = recentKeys.get(key);
  if (prev && (prev !== 'dom' || data.source !== 'dom')) return log('팝업 생략', { reason: 'dup' });
  recentKeys.set(key, data.source);
  setTimeout(() => recentKeys.delete(key), 10000);

  while (popups.length >= MAX_POPUPS) closePopup(popups[popups.length - 1].win);

  const win = new BrowserWindow({
    width: POPUP_W,
    height: POPUP_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'popup', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');

  const p = {
    win, data, loaded: false, pending: null,
    msg: kind === 'typing' ? '' : data.body,
    typing: kind === 'typing',
    typingText: kind === 'typing' ? data.body : '',
  };
  popups.unshift(p);
  layoutPopups();
  sendPopup(p, kind === 'msg');

  // 불러오는 동안 바뀐 내용은 pending에 모아 두었다가 다 불러온 뒤 한 번에 보낸다
  win.webContents.once('did-finish-load', () => {
    p.loaded = true;
    if (p.pending) win.webContents.send('popup:update', p.pending);
  });
  win.loadFile(path.join(__dirname, 'popup', 'popup.html'));
  win.once('ready-to-show', () => win.showInactive());
}

// 프로필 사진이 늦게 오면 떠 있는 팝업에 끼워 넣는다
function setPopupIcon(tag, icon) {
  const p = tag && popups.find((x) => x.data.tag === tag && !x.win.isDestroyed());
  if (!p || !icon || p.data.icon === icon) return;
  p.data.icon = icon;
  sendPopup(p, false);
}

ipcMain.on('popup:click', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const p = popups.find((x) => x.win === win);
  if (p) openFromPopup(p.data);
  if (win) closePopup(win);
});

ipcMain.on('popup:close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) closePopup(win);
});

/* ---------------- 페이지 → 메인 ---------------- */

ipcMain.on('dm:notify', async (_e, n) => {
  const source = n.source || 'page';
  // 페이지가 보내는 알림에는 좋아요 등 활동 알림이 섞이고, 받은편지함 데이터와 같은 DM을 겹쳐 알린다.
  // 데이터 방식이 잘 되면 페이지 알림은 버리고, 안 될 때만 DM으로 보이는 것을 통과시킨다.
  if (source === 'page' && (apiHealthy() || !/direct/.test(`${n.url || ''} ${n.tag || ''}`))) {
    log('페이지 알림 무시', { apiHealthy: apiHealthy() });
    return;
  }
  const kind = ['typing', 'typing-stop'].includes(n.kind) ? n.kind : 'msg';
  if (kind !== 'typing-stop') log('알림', { source, kind, hasBody: !!n.body, hasIcon: !!n.icon });
  const tag = String(n.tag || '');
  // 사진을 기다리지 않고 바로 띄운다(기다리면 늦게 받은 "입력 중"이 먼저 온 메시지를 덮을 수 있음). 사진은 오면 끼운다.
  showPopup({
    id: Number(n.id) || 0,
    title: String(n.title || 'Instagram').slice(0, 100),
    body: String(n.body || '').slice(0, 300),
    icon: avatarCache.get(n.icon) || '',
    tag,
    url: isInstagram(n.url || '') ? n.url : '',
    source,
    kind,
  });
  if (kind === 'typing-stop') return;
  if (!avatarCache.has(n.icon)) resolveAvatar(n.icon).then((icon) => setPopupIcon(tag, icon));
  flashIfHidden();
});

// 받은편지함 사진 클릭을 가로챈 시각 (스토리가 열려 버리면 되돌리는 데 씀)
ipcMain.on('dm:avatar-click', () => { avatarClickAt = Date.now(); });

// 감시 창 상태 기록 (메시지 내용 없음)
let lastApiStatus = '';
ipcMain.on('watcher:status', (_e, s) => {
  if (s.source === 'api') {
    if (s.ok) apiOkAt = Date.now();
    // 같은 상태가 반복되면 기록하지 않음
    const key = JSON.stringify({ ok: s.ok, threads: s.threads, httpStatus: s.httpStatus, error: s.error });
    if (key === lastApiStatus && s.reason === 'interval') return;
    lastApiStatus = key;
  }
  log('감시', s);
});

// 받은편지함 데이터로 센 읽지 않은 대화 수 (DM만)
ipcMain.on('dm:unread-api', (_e, count) => {
  apiUnread = Math.max(0, Number(count) || 0);
  updateBadge();
});

// 탭 제목은 새 메시지가 있으면 "(1) Instagram" ↔ "OO님이 메시지를 보냈습니다"처럼 깜빡여서
// 숫자가 0과 1을 오간다. 줄어드는 쪽은 5초간 그대로일 때만 반영한다.
// 숫자가 바뀌면 받은편지함 데이터를 바로 확인해 DM 알림과 배지를 맞춘다 (요약 팝업은 띄우지 않음).
let unreadTimer = null;
ipcMain.on('dm:unread', (_e, count) => {
  clearTimeout(unreadTimer);
  const n = Math.max(0, Number(count) || 0);
  if (n === unread) return;
  unreadTimer = setTimeout(() => {
    const prev = unread;
    unread = n;
    if (unread > prev) log('읽지 않음 증가', prev, '→', unread);
    updateBadge();
    if (watcherWindow && !watcherWindow.isDestroyed()) watcherWindow.webContents.send('watcher:check');
  }, n < unread ? 5000 : 1500);
});

// 대화 목록 구조(메시지 내용 없이 태그·글자 수만)를 파일로 저장
ipcMain.on('watcher:dump-result', (_e, result) => {
  const file = path.join(app.getPath('desktop'), 'InstaDM-진단.json');
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  shell.showItemInFolder(file);
});

function flashIfHidden() {
  if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
}

/* ---------------- 트레이 / 배지 ---------------- */

// 데이터 방식이 잘 되면 DM만 센 숫자를 쓴다. 제목 숫자가 먼저 줄어들 수 있어(읽음) 둘 중 작은 값.
function badgeCount() {
  return apiUnread !== null && apiHealthy() ? Math.min(apiUnread, unread) : unread;
}

function updateBadge() {
  if (!tray) return;
  const n = badgeCount();
  tray.setToolTip(`InstaDM ${app.getVersion()}${n ? ` — 읽지 않음 ${n}` : ''}`);
  if (mainWindow) {
    mainWindow.setOverlayIcon(
      n ? nativeImage.createFromPath(path.join(ASSETS, 'badge.png')) : null,
      n ? `읽지 않음 ${n}` : '',
    );
    mainWindow.setTitle(n ? `(${n}) InstaDM` : 'InstaDM');
  }
  sendTitlebarState();
}

function menuTemplate() {
  const toggle = (key) => () => {
    settings[key] = !settings[key];
    saveSettings();
    refreshMenus();
  };
  const autoStart = app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;

  return [
    { label: 'InstaDM 열기', click: () => showMain() },
    { label: 'DM 받은편지함', click: () => showMain(INBOX_URL) },
    { type: 'separator' },
    { label: '알림 받기', type: 'checkbox', checked: settings.notify, click: toggle('notify') },
    { label: '알림 소리', type: 'checkbox', checked: settings.sound, click: toggle('sound') },
    { label: '메시지 미리보기', type: 'checkbox', checked: settings.preview, click: toggle('preview') },
    { label: '대화를 새 창에서 열기', type: 'checkbox', checked: settings.chatWindow, click: toggle('chatWindow') },
    {
      label: 'Windows 시작 시 실행',
      type: 'checkbox',
      checked: autoStart,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
      },
    },
    { type: 'separator' },
    {
      label: '보기',
      submenu: [
        { label: '확대', accelerator: 'Ctrl+=', registerAccelerator: false, click: () => zoom(0.5) },
        { label: '축소', accelerator: 'Ctrl+-', registerAccelerator: false, click: () => zoom(-0.5) },
        { label: '원래 크기', accelerator: 'Ctrl+0', registerAccelerator: false, click: () => zoom(0) },
      ],
    },
    {
      label: '알림 테스트',
      click: () => {
        const wasFocused = mainWindow && mainWindow.isFocused();
        if (wasFocused) mainWindow.blur();
        showPopup({
          id: 0,
          title: '테스트',
          body: '이렇게 오른쪽 아래에 DM 알림이 떠요 👋',
          icon: '',
          tag: 'test-' + Date.now(),
          url: INBOX_URL,
        });
      },
    },
    {
      label: '새로고침',
      accelerator: 'Ctrl+R',
      registerAccelerator: false,
      click: () => {
        if (igView) igView.webContents.reload();
        if (watcherWindow) watcherWindow.loadURL(INBOX_URL);
      },
    },
    { type: 'separator' },
    {
      label: '알림 경로 점검',
      click: () => watcherWindow && watcherWindow.webContents.send('watcher:selftest'),
    },
    {
      label: '감시 창 보기',
      type: 'checkbox',
      checked: !!(watcherWindow && !watcherWindow.isDestroyed() && watcherWindow.isVisible()),
      click: (item) => {
        if (!watcherWindow) return;
        if (item.checked) watcherWindow.show();
        else watcherWindow.hide();
      },
    },
    { label: '로그 파일 열기', click: () => shell.openPath(logPath()) },
    {
      label: '문제 진단 파일 저장',
      click: () => watcherWindow && watcherWindow.webContents.send('watcher:dump'),
    },
    { type: 'separator' },
    { label: `버전 ${app.getVersion()}`, enabled: false },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ];
}

// 트레이 우클릭 메뉴. 창에서는 타이틀바의 설정 버튼이 같은 메뉴를 띄운다 (menuTemplate을 매번 새로 만듦)
function refreshMenus() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.setToolTip(`InstaDM ${app.getVersion()}`);
  refreshMenus();
  tray.on('click', () => showMain());
}

/* ---------------- 시작 ---------------- */

app.on('second-instance', () => showMain());

app.whenReady().then(() => {
  app.setAppUserModelId('local.insta-dm');
  loadSettings();
  log('시작', app.getVersion());
  Menu.setApplicationMenu(null);

  // Instagram 웹이 알림 권한을 받을 수 있게 허용
  const ses = session.fromPartition('persist:instagram');
  // 채팅 창은 Notification을 가로채지 않으므로 알림 권한을 주지 않는다 (주면 Windows 알림이 따로 뜸)
  const allowed = (wc, permission) => ['notifications', 'clipboard-sanitized-write', 'media'].includes(permission)
    && !(permission === 'notifications' && wc && isChatContents(wc));
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(allowed(wc, permission)));
  ses.setPermissionCheckHandler((wc, permission) => allowed(wc, permission));

  createMainWindow();
  createWatcherWindow();
  createTray();
  screen.on('display-metrics-changed', layoutPopups);
  setTimeout(prepareWarmChat, 15000); // 시작 직후 로딩과 겹치지 않게 조금 뒤에

  // 절전·화면 잠금 동안 감시 창 타이머가 멈춘다(11-04 로그에 6분 공백). 돌아오면 감시 창을 다시 불러온다.
  // 다시 불러오면 첫 검사는 기준만 잡으므로 그동안 쌓인 것이 한꺼번에 뜨지는 않는다.
  const reloadWatcher = (why) => {
    log('감시 창 다시 불러옴', why);
    if (watcherWindow && !watcherWindow.isDestroyed()) watcherWindow.loadURL(INBOX_URL);
  };
  powerMonitor.on('resume', () => reloadWatcher('resume'));
  powerMonitor.on('unlock-screen', () => reloadWatcher('unlock'));

  // npm run test-popup: 시작 후 예시 알림 두 개 띄우기
  if (process.argv.includes('--test-popup')) {
    setTimeout(() => {
      showPopup({ id: 0, title: 'minji_kim', body: '내일 몇 시에 만나? 😊', icon: '', tag: 't1', url: INBOX_URL });
      showPopup({ id: 0, title: 'jun.seo', body: '사진 보냈어! 확인해줘', icon: '', tag: 't2', url: INBOX_URL });
    }, 1500);
  }
});

app.on('before-quit', () => { quitting = true; });
// 창이 모두 닫혀도 트레이에 남아 있는다
app.on('window-all-closed', () => {});
