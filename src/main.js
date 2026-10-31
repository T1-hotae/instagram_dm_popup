const {
  app, BrowserWindow, WebContentsView, Tray, Menu, ipcMain, screen, shell, nativeImage, nativeTheme, session, dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');

const INBOX_URL = 'https://www.instagram.com/direct/inbox/';
const ASSETS = path.join(__dirname, '..', 'assets');
const START_HIDDEN = process.argv.includes('--hidden');

// Electron 표기가 붙은 UA는 Instagram이 "지원하지 않는 브라우저"로 막을 수 있어 일반 Chrome UA로 맞춘다.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s?Electron\/\S+/, '')
  .replace(/\s?insta-dm\/\S+/i, '');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/* ---------------- 설정 ---------------- */

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const defaults = { notify: true, sound: true, preview: true };
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
      preload: path.join(__dirname, 'titlebar-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'titlebar.html'));

  igView = new WebContentsView({
    webPreferences: {
      partition: 'persist:instagram', // 로그인 유지
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
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
    if (p.startsWith('/accounts/') || p.startsWith('/challenge')) log('메인 이동', p);
    // 받은편지함 사진 클릭을 막지 못해 스토리가 열렸으면 되돌린다
    if (p.startsWith('/stories/') && Date.now() - avatarClickAt < 1500) {
      avatarClickAt = 0;
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    }
    syncTheme();
  };
  wc.on('did-navigate', onMainNavigate);
  wc.on('did-navigate-in-page', onMainNavigate);
  wc.on('did-finish-load', syncTheme);

  // 새 창 요청: 페이스북·Meta 로그인은 앱 안 작은 창에서 (같은 세션이라 로그인이 반영됨),
  // Instagram 안의 링크는 메인 창에서, 외부 링크는 기본 브라우저로
  wc.setWindowOpenHandler(({ url }) => {
    if (isMetaLogin(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: mainWindow,
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          title: '로그인',
          webPreferences: { partition: 'persist:instagram', contextIsolation: true, sandbox: true },
        },
      };
    }
    if (isInstagram(url)) wc.loadURL(url);
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (e, url) => {
    if (!isInstagram(url) && !isMetaLogin(url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  // 메뉴바가 없어서 단축키를 직접 처리
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.control) return;
    const key = input.key.toLowerCase();
    if (key === 'r') wc.reload();
    else if (key === '=' || key === '+') zoom(0.5);
    else if (key === '-') zoom(-0.5);
    else if (key === '0') zoom(0);
    else if (key === 'i' && input.shift) wc.openDevTools({ mode: 'detach' });
    else return;
    e.preventDefault();
  });

  setInterval(() => mainWindow.isVisible() && syncTheme(), 5000);
}

function zoom(step) {
  if (!igView) return;
  const wc = igView.webContents;
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
      preload: path.join(__dirname, 'watcher-preload.js'),
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

/* ---------------- 우측 하단 팝업 알림 ---------------- */

const POPUP_W = 360;
const POPUP_H = 104;
const POPUP_GAP = 4;
const MAX_POPUPS = 4;
const popups = [];
const recentKeys = new Set();

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

function showPopup(data) {
  if (!settings.notify) return;
  // 창을 보고 있는 중이면 팝업을 띄우지 않는다
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) return;

  // 페이지 알림과 감시 창이 같은 메시지를 동시에 알린 경우 한 번만 띄운다
  const key = data.title + '|' + data.body;
  if (recentKeys.has(key)) return;
  recentKeys.add(key);
  setTimeout(() => recentKeys.delete(key), 10000);

  // 같은 대화(tag)의 팝업이 이미 떠 있으면 새 내용으로 교체
  if (data.tag) {
    const same = popups.find((p) => p.data.tag === data.tag);
    if (same) closePopup(same.win);
  }
  while (popups.length >= MAX_POPUPS) closePopup(popups[popups.length - 1].win);

  const payload = {
    ...data,
    body: settings.preview ? data.body : '새 메시지가 도착했습니다.',
    sound: settings.sound,
  };

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
      preload: path.join(__dirname, 'popup-preload.js'),
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');

  popups.unshift({ win, data });
  layoutPopups();

  win.loadFile(path.join(__dirname, 'popup.html'), {
    query: { d: JSON.stringify(payload) },
  });
  win.once('ready-to-show', () => win.showInactive());
}

ipcMain.on('popup:click', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const p = popups.find((x) => x.win === win);
  if (p) {
    if (p.data.id && igView) {
      // 페이지가 등록한 알림 onclick을 실행 → Instagram이 해당 대화로 이동
      igView.webContents.send('dm:click', p.data.id);
      showMain();
    } else {
      showMain(p.data.url || INBOX_URL);
    }
  }
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
  log('알림', { source, hasBody: !!n.body, hasIcon: !!n.icon });
  const icon = await resolveAvatar(n.icon);
  showPopup({
    id: Number(n.id) || 0,
    title: String(n.title || 'Instagram').slice(0, 100),
    body: String(n.body || '').slice(0, 300),
    icon,
    tag: String(n.tag || ''),
    url: isInstagram(n.url || '') ? n.url : '',
  });
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
  tray.setToolTip(n ? `InstaDM — 읽지 않음 ${n}` : 'InstaDM');
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
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ];
}

// 트레이 우클릭 메뉴. 창에서는 타이틀바의 설정 버튼이 같은 메뉴를 띄운다 (menuTemplate을 매번 새로 만듦)
function refreshMenus() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.setToolTip('InstaDM');
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
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['notifications', 'clipboard-sanitized-write', 'media'].includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) =>
    ['notifications', 'clipboard-sanitized-write', 'media'].includes(permission));

  createMainWindow();
  createWatcherWindow();
  createTray();
  screen.on('display-metrics-changed', layoutPopups);

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
