'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeTheme,
  safeStorage,
  screen,
  shell
} = require('electron');
const { ConfigStore } = require('./services/config-store');
const { ArchiveStore } = require('./services/archive-store');
const { ContactStore } = require('./services/contact-store');
const { GoogleCalendarService } = require('./services/google-calendar');
const { CompletionSync } = require('./services/completion-sync');
const { createTrayClickActions } = require('./lib/tray-clicks');

let mainWindow;
let tray;
let quitting = false;
let store;
let archiveStore;
let contactStore;
let calendarService;
let completionSync;
let trayClicks;
const TRAY_CLICK_DELAY_MS = 500;
const GOOGLE_CALENDAR_URL = 'https://calendar.google.com/calendar/';

if (process.env.CALENDAR_TRAY_SMOKE_USER_DATA) {
  app.setPath('userData', process.env.CALENDAR_TRAY_SMOKE_USER_DATA);
}

function getIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', 'build', 'icon.ico');
}

function placeWindow() {
  if (!mainWindow || !tray) return;
  const bounds = mainWindow.getBounds();
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const work = display.workArea;
  const centerX = trayBounds.x + trayBounds.width / 2;
  const centerY = trayBounds.y + trayBounds.height / 2;
  const horizontalTaskbar = trayBounds.width >= trayBounds.height;
  let x;
  let y;
  if (horizontalTaskbar) {
    x = Math.round(centerX - bounds.width / 2);
    x = Math.max(work.x + 8, Math.min(x, work.x + work.width - bounds.width - 8));
    y = trayBounds.y > work.y + work.height / 2 ? work.y + work.height - bounds.height - 8 : work.y + 8;
  } else {
    x = trayBounds.x > work.x + work.width / 2 ? work.x + work.width - bounds.width - 8 : work.x + 8;
    y = Math.round(centerY - bounds.height / 2);
    y = Math.max(work.y + 8, Math.min(y, work.y + work.height - bounds.height - 8));
  }
  mainWindow.setPosition(x, y, false);
}

function showWindow(page) {
  if (!mainWindow) return;
  placeWindow();
  mainWindow.show();
  mainWindow.focus();
  if (page) mainWindow.webContents.send('navigate', page);
}

function toggleWindow() {
  if (mainWindow.isVisible()) mainWindow.hide();
  else showWindow();
}

function createWindow() {
  const work = screen.getPrimaryDisplay().workArea;
  mainWindow = new BrowserWindow({
    width: Math.min(940, work.width - 16),
    height: Math.min(820, work.height - 16),
    minWidth: 600,
    minHeight: 520,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: '#11151c',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('show', () => mainWindow.webContents.send('sync-refresh'));
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('blur', () => {
    if (mainWindow?.isVisible() && !mainWindow.webContents.isDevToolsOpened()) mainWindow.hide();
  });
}

function createTray() {
  tray = new Tray(getIconPath());
  tray.setToolTip('Google Calendar Tray — один клик: повестка, два: Google Calendar');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть календарь', click: () => showWindow('calendar') },
    { label: 'Настройки', click: () => showWindow('settings') },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } }
  ]));
  trayClicks = createTrayClickActions({
    singleClick: toggleWindow,
    doubleClick: () => {
      mainWindow?.hide();
      shell.openExternal(GOOGLE_CALENDAR_URL).catch((error) => {
        dialog.showErrorBox('Не удалось открыть Google Calendar', error.message);
      });
    },
    delayMs: TRAY_CLICK_DELAY_MS
  });
  tray.on('click', trayClicks.click);
  tray.on('double-click', trayClicks.doubleClick);
}

function registerIpc() {
  ipcMain.handle('app:get-initial-state', async () => ({
    settings: store.getPublicSettings(),
    auth: await calendarService.status(),
    appVersion: app.getVersion(),
    trayReady: Boolean(tray && !tray.isDestroyed()),
    windowVisible: Boolean(mainWindow?.isVisible())
  }));
  ipcMain.handle('settings:save', (_event, settings) => store.setPublicSettings(settings));
  ipcMain.handle('auth:import-credentials', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите credentials.json',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return calendarService.importCredentials(result.filePaths[0]);
  });
  ipcMain.handle('auth:sign-in', () => calendarService.signIn());
  ipcMain.handle('auth:sign-out', () => calendarService.signOut());
  ipcMain.handle('calendar:list', () => calendarService.listCalendars());
  ipcMain.handle('events:list', (_event, args) => calendarService.listEvents(args));
  ipcMain.handle('events:create', (_event, args) => calendarService.createEvent(args));
  ipcMain.handle('events:update', (_event, args) => calendarService.updateEvent(args));
  ipcMain.handle('events:delete', (_event, args) => calendarService.deleteEvent(args));
  ipcMain.handle('archive:cached', (_event, accountId) => archiveStore.list(accountId));
  ipcMain.handle('archive:list', (_event, accountId) => completionSync.list(accountId));
  ipcMain.handle('archive:add', (_event, accountId, event) => completionSync.archive(accountId, event));
  ipcMain.handle('archive:restore', (_event, accountId, calendarId, eventId) => completionSync.restore(accountId, calendarId, eventId));
  ipcMain.handle('contacts:list', () => contactStore.list());
  ipcMain.handle('contacts:save', (_event, contact) => contactStore.upsert(contact));
  ipcMain.handle('contacts:remember', (_event, emails) => contactStore.remember(emails));
  ipcMain.handle('contacts:remove', (_event, email) => contactStore.remove(email));
  ipcMain.handle('app:open-external', (_event, url) => shell.openExternal(url));
  ipcMain.on('window:hide', () => mainWindow?.hide());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    store = new ConfigStore(app.getPath('userData'), safeStorage);
    archiveStore = new ArchiveStore(app.getPath('userData'));
    contactStore = new ContactStore(app.getPath('userData'));
    calendarService = new GoogleCalendarService({ app, shell, store });
    completionSync = new CompletionSync(calendarService, archiveStore);
    registerIpc();
    createWindow();
    createTray();
  });
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; trayClicks?.dispose(); });
}
