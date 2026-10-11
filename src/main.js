const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, nativeImage, session,
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

/* ---------------- 메인 창 ---------------- */

let mainWindow = null;
let tray = null;
let quitting = false;
let unread = 0;
let lastNotifyAt = 0;
let fallbackTimer = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    title: 'InstaDM',
    icon: path.join(ASSETS, 'icon.png'),
    show: false,
    autoHideMenuBar: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: 'persist:instagram', // 로그인 유지
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(INBOX_URL);

  mainWindow.once('ready-to-show', () => {
    if (!START_HIDDEN) mainWindow.show();
  });

  // X 버튼은 종료가 아니라 트레이로 숨기기 (카카오톡과 동일)
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('focus', () => mainWindow.flashFrame(false));

  let lastMainUrl = '';
  const onMainNavigate = (_e, url) => {
    if (lastMainUrl.includes('/accounts/') && !url.includes('/accounts/')) reloadWatcherSoon();
    lastMainUrl = url;
  };
  mainWindow.webContents.on('did-navigate', onMainNavigate);
  mainWindow.webContents.on('did-navigate-in-page', onMainNavigate);

  // 새 창 요청: Instagram 안의 링크는 메인 창에서, 외부 링크는 기본 브라우저로
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInstagram(url)) mainWindow.loadURL(url);
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isInstagram(url) && !isMetaLogin(url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
}

// 화면에 보이지 않는 감시 창: 항상 DM 받은편지함을 띄워 두고 새 메시지 내용을 읽는다.
// 가로 폭을 넓게 잡아야 대화 목록이 보이는 데스크톱 화면 구성이 나온다.
let watcherWindow = null;

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

  // 받은편지함을 벗어나면(로그인 화면 등) 잠시 뒤 다시 받은편지함으로
  watcherWindow.webContents.on('did-navigate', (_e, url) => {
    if (!url.startsWith(INBOX_URL)) {
      setTimeout(() => watcherWindow && !watcherWindow.isDestroyed() && watcherWindow.loadURL(INBOX_URL), 60000);
    }
  });
  // 메모리 누수 방지를 위해 3시간마다 새로고침
  setInterval(() => watcherWindow && !watcherWindow.isDestroyed() && watcherWindow.loadURL(INBOX_URL), 3 * 60 * 60 * 1000);

  watcherWindow.on('close', (e) => { if (!quitting) e.preventDefault(); });
}

// 메인 창에서 로그인하면 감시 창도 로그인 상태로 다시 연다
function reloadWatcherSoon() {
  setTimeout(() => watcherWindow && !watcherWindow.isDestroyed() && watcherWindow.loadURL(INBOX_URL), 3000);
}

function isInstagram(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'instagram.com' || h.endsWith('.instagram.com');
  } catch {
    return false;
  }
}

// 페이스북 계정으로 로그인하는 흐름은 창 안에서 허용
function isMetaLogin(url) {
  try {
    const h = new URL(url).hostname;
    return h.endsWith('facebook.com') || h.endsWith('accountscenter.instagram.com');
  } catch {
    return false;
  }
}

function showMain(url) {
  if (!mainWindow) return;
  if (url && isInstagram(url)) mainWindow.loadURL(url);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
    if (p.data.id && mainWindow) {
      // 페이지가 등록한 알림 onclick을 실행 → Instagram이 해당 대화로 이동
      mainWindow.webContents.send('dm:click', p.data.id);
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

ipcMain.on('dm:notify', (_e, n) => {
  lastNotifyAt = Date.now();
  showPopup({
    id: Number(n.id) || 0,
    title: String(n.title || 'Instagram').slice(0, 100),
    body: String(n.body || '').slice(0, 300),
    icon: /^https:\/\//.test(n.icon || '') ? n.icon : '',
    tag: String(n.tag || ''),
    url: isInstagram(n.url || '') ? n.url : '',
  });
  flashIfHidden();
});

ipcMain.on('dm:unread', (_e, count) => {
  const prev = unread;
  unread = Math.max(0, Number(count) || 0);
  updateBadge();

  if (unread > prev) {
    flashIfHidden();
    // 페이지가 알림을 직접 보내지 않은 경우(백그라운드 등)를 위한 대체 팝업
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      if (Date.now() - lastNotifyAt > 8000) {
        showPopup({
          id: 0,
          title: 'Instagram',
          body: `읽지 않은 메시지·알림이 ${unread}개 있어요.`,
          icon: '',
          tag: 'unread-summary',
          url: INBOX_URL,
        });
      }
    }, 6000);
  }
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

function updateBadge() {
  if (!tray) return;
  tray.setToolTip(unread ? `InstaDM — 읽지 않음 ${unread}` : 'InstaDM');
  if (mainWindow) {
    mainWindow.setOverlayIcon(
      unread ? nativeImage.createFromPath(path.join(ASSETS, 'badge.png')) : null,
      unread ? `읽지 않음 ${unread}` : '',
    );
    mainWindow.setTitle(unread ? `(${unread}) InstaDM` : 'InstaDM');
  }
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
      click: () => {
        if (mainWindow) mainWindow.webContents.reload();
        if (watcherWindow) watcherWindow.loadURL(INBOX_URL);
      },
    },
    {
      label: '문제 진단 파일 저장',
      click: () => watcherWindow && watcherWindow.webContents.send('watcher:dump'),
    },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ];
}

// 트레이 우클릭 메뉴와 창 위 '설정' 메뉴를 같은 내용으로 유지
function refreshMenus() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '설정', submenu: menuTemplate() },
    { label: '보기', submenu: [{ role: 'reload', label: '새로고침' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' }, { role: 'resetZoom', label: '원래 크기' }] },
  ]));
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
