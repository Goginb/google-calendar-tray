'use strict';

// Exercise the real renderer and preload against an isolated calendar API fixture.
// Mouse input goes through Chromium so pointer capture, scrolling and click suppression are tested.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, '--disable-gpu', '--no-sandbox'], { env, stdio: 'inherit', windowsHide: true, timeout: 60000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { ArchiveStore } = require('../src/services/archive-store');
  const { ConfigStore } = require('../src/services/config-store');
  const { CompletionSync } = require('../src/services/completion-sync');
  const { createRemoteCalendar } = require('../test/helpers/completion-api');
  const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-timeline-smoke-'));
  app.setPath('userData', testData);
  const archiveStore = new ArchiveStore(testData);
  const configStore = new ConfigStore(testData, {});
  let win;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const calls = [];
  let failUpdate = false;
  let failRestore = false;
  let failSettings = false;
  let delayedArchiveRead = null;
  let archiveReadWaiting = false;
  let events;
  const date = '2026-10-05';
  const timed = (id, title, start, end, calendarId = 'team') => ({
    id, calendarId, summary: title, location: 'Офис', description: 'Описание встречи',
    start: { dateTime: new Date(`${date}T${start}`).toISOString(), timeZone: 'Europe/Moscow' },
    end: { dateTime: new Date(`${date}T${end}`).toISOString(), timeZone: 'Europe/Moscow' },
    attendees: [{ email: 'guest@example.com', responseStatus: 'accepted' }]
  });
  function resetFixture() {
    events = [
      timed('a', 'Планирование недели', '09:00', '10:00'),
      timed('b', 'Работа над проектом', '09:30', '11:30', 'work'),
      timed('c', 'Короткая встреча', '12:00', '12:15'),
      timed('readonly', 'Общий календарь', '11:30', '12:30', 'readonly'),
      { id: 'all-day', calendarId: 'team', summary: 'Подготовка релиза', description: 'Проверить готовность установщика', start: { date }, end: { date: '2026-10-07' } }
    ];
    events.find((event) => event.id === 'b').description = '';
  }
  resetFixture();
  const calendars = [
    { id: 'team', primary: true, summary: 'Команда', accessRole: 'owner', backgroundColor: '#4285f4' },
    { id: 'work', summary: 'Проекты', accessRole: 'writer', backgroundColor: '#34a853' },
    { id: 'readonly', summary: 'Общий календарь', accessRole: 'reader', backgroundColor: '#b58aff' }
  ];
  const remote = createRemoteCalendar('team');
  remote.calendars = calendars.map((calendar) => ({ ...calendar }));
  const completionSync = new CompletionSync(remote.service(), archiveStore);
  const otherDevice = new CompletionSync(remote.service(), new ArchiveStore(path.join(testData, 'other-device')));
  const settings = { viewMode: 'today', selectedCalendarIds: calendars.map((calendar) => calendar.id), calendarSelectionInitialized: true };
  configStore.setPublicSettings(settings);
  ipcMain.handle('app:get-initial-state', () => ({ auth: { signedIn: true, credentialsConfigured: true }, settings: configStore.getPublicSettings(), appVersion: 'test', trayReady: false, windowVisible: false }));
  ipcMain.handle('calendar:list', () => calendars);
  ipcMain.handle('settings:save', (_event, value) => {
    if (failSettings) throw new Error('Тестовая ошибка сохранения настроек');
    return configStore.setPublicSettings(value);
  });
  ipcMain.handle('contacts:list', () => []);
  ipcMain.handle('contacts:remember', () => []);
  ipcMain.handle('archive:cached', (_event, accountId) => archiveStore.list(accountId));
  ipcMain.handle('archive:list', async (_event, accountId) => {
    const result = await completionSync.list(accountId);
    if (delayedArchiveRead) { archiveReadWaiting = true; await delayedArchiveRead; }
    return result;
  });
  ipcMain.handle('archive:add', (_event, accountId, event) => completionSync.archive(accountId, event));
  ipcMain.handle('archive:restore', (_event, accountId, calendarId, eventId) => {
    if (failRestore) throw new Error('Тестовая ошибка восстановления');
    return completionSync.restore(accountId, calendarId, eventId);
  });
  ipcMain.handle('events:list', (_event, args) => events.filter((event) => {
    const start = new Date(event.start.dateTime || `${event.start.date}T00:00`);
    const end = new Date(event.end.dateTime || `${event.end.date}T00:00`);
    return end > new Date(args.timeMin) && start < new Date(args.timeMax);
  }));
  ipcMain.handle('events:update', (_event, args) => {
    calls.push(args);
    if (failUpdate) throw new Error('Тестовая ошибка сети');
    const index = events.findIndex((event) => event.id === args.eventId && event.calendarId === args.calendarId);
    if (index < 0) throw new Error('Событие не найдено');
    events[index] = { ...events[index], ...args.resource };
    return events[index];
  });
  function check(condition, message) { if (!condition) throw new Error(message); }
  const evaluate = (expression) => win.webContents.executeJavaScript(expression);
  async function waitFor(expression, timeout = 2000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(20); }
    throw new Error(`Таймлайн не готов: ${expression}`);
  }
  async function point(selector, offsetY) {
    return evaluate(`(() => { const item = document.querySelector(${JSON.stringify(selector)}); if (!item) throw Error('Нет элемента ' + ${JSON.stringify(selector)}); const rect = item.getBoundingClientRect(); return { x: rect.left + Math.min(30, rect.width / 2), y: rect.top + ${offsetY === undefined ? 'rect.height / 2' : Number(offsetY)} }; })()`);
  }
  const row = (id) => `.timeline-event[data-event-id="${id}"]`;
  async function mouse(type, point, pressed) {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: pressed || type === 'mouseReleased' ? 'left' : 'none', buttons: pressed ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
  async function beginDrag(selector, dx, dy, offsetY) {
    const start = await point(selector, offsetY);
    const end = { x: start.x + dx, y: start.y + dy };
    await mouse('mouseMoved', start, false);
    await mouse('mousePressed', start, true);
    for (let step = 1; step <= 4; step++) {
      await mouse('mouseMoved', { x: start.x + dx * step / 4, y: start.y + dy * step / 4 }, true);
      await delay(10);
    }
    return end;
  }
  async function drag(selector, dx, dy, offsetY) {
    const end = await beginDrag(selector, dx, dy, offsetY);
    await mouse('mouseReleased', end, false);
    await waitFor('!activeTimelineGesture && !state.mutationInProgress');
    await delay(30);
  }
  async function click(selector) {
    const center = await point(selector);
    await mouse('mouseMoved', center, false); await delay(20);
    await mouse('mousePressed', center, true); await mouse('mouseReleased', center, false);
    await delay(40);
    await waitFor('!state.mutationInProgress && !document.querySelector("#showAllEvents").disabled');
  }
  async function eventInfo(id) {
    return evaluate(`(() => { const item = state.events.find((event) => event.id === ${JSON.stringify(id)}); const row = document.querySelector(${JSON.stringify(row(id))}); return { start: item.start.dateTime, end: item.end.dateTime, height: row?.getBoundingClientRect().height, day: row?.parentElement.dataset.date, editor: !document.querySelector('#editorPage').classList.contains('hidden') }; })()`);
  }
  async function snapshot(filename) {
    await evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const result = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    const directory = path.join(__dirname, '..', 'dist'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, filename), result.toPNG());
  }

  app.whenReady().then(async () => {
    try {
      win = new BrowserWindow({ width: 940, height: 820, frame: false, show: false, backgroundColor: '#11151c', webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
      win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') console.error('Renderer:', details.message); });
      await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
      win.webContents.focus();
      win.webContents.debugger.attach('1.3');
      await waitFor('document.querySelector(".timeline-day") && !state.loading');
      await evaluate(`state.anchorDate = new Date('${date}T00:00'); loadEvents()`);
      await waitFor('document.querySelector(".timeline-event[data-event-id=a]")');
      const geometry = await evaluate(`(() => {
        const a = document.querySelector('.timeline-event[data-event-id=a]').getBoundingClientRect();
        const b = document.querySelector('.timeline-event[data-event-id=b]').getBoundingClientRect();
        const c = document.querySelector('.timeline-event[data-event-id=c]').getBoundingClientRect();
        return { aHeight: a.height, bHeight: b.height, cHeight: c.height, separated: a.right <= b.left || b.right <= a.left, hours: document.querySelectorAll('.hour-label').length, readonlyHandle: !!document.querySelector('.timeline-event[data-event-id=readonly] .event-resize-handle'), allDay: document.querySelectorAll('.all-day-events .event-row').length, overflow: document.body.scrollWidth > innerWidth };
      })()`);
      check(geometry.aHeight === 80 && geometry.bHeight === 160 && geometry.cHeight === 20 && geometry.separated && geometry.hours === 25 && !geometry.readonlyHandle && geometry.allDay === 1 && !geometry.overflow, `Неверная геометрия календаря: ${JSON.stringify(geometry)}`);
      console.log('Timeline geometry OK');
      await snapshot('timeline-preview-day.png');
      await drag(`${row('a')} .event-card`, 0, 80, 12);
      let info = await eventInfo('a');
      check(new Date(info.start).getHours() === 10 && new Date(info.end).getHours() === 11 && !info.editor && calls.length === 1, `Перенос мышью не сохранился: ${JSON.stringify({ info, calls })}`);
      check(Object.keys(calls[0].resource).sort().join(',') === 'end,start' && calls[0].calendarId === 'team' && calls[0].eventId === 'a', 'Перенос заменяет посторонние поля или выбран не тот календарь');
      await drag(`${row('a')} .event-resize-handle`, 0, 40);
      info = await eventInfo('a');
      check(new Date(info.end) - new Date(info.start) === 90 * 60000 && info.height === 120 && !info.editor, 'Нижний край не увеличивает длительность');
      await drag(`${row('a')} .event-resize-handle`, 0, -200);
      info = await eventInfo('a');
      check(new Date(info.end) - new Date(info.start) === 15 * 60000 && info.height === 20, 'Минимальная длительность не соблюдается');

      const beforeCancel = calls.length;
      const end = await beginDrag(`${row('a')} .event-card`, 0, 40, 5);
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await mouse('mouseReleased', end, false);
      await delay(30);
      check(calls.length === beforeCancel && !await evaluate('!!activeTimelineGesture || !!document.querySelector(".timeline-ghost")'), 'Escape не отменяет перенос');
      await drag(`${row('a')} .event-card`, -900, 0, 5);
      check(calls.length === beforeCancel, 'Отпускание вне сетки сохраняет перенос');
      await drag(`${row('readonly')} .event-card`, 0, 20, 12);
      check(calls.length === beforeCancel, 'Событие только для чтения изменилось');

      failUpdate = true;
      const beforeFailure = await eventInfo('a');
      await drag(`${row('a')} .event-card`, 0, 20, 5);
      info = await eventInfo('a');
      check(calls.length === beforeCancel + 1 && info.start === beforeFailure.start && info.end === beforeFailure.end && info.height === beforeFailure.height && await evaluate('document.querySelector("#toast").textContent.includes("Не удалось сохранить")'), 'Ошибка сохранения не восстанавливает исходное время');
      failUpdate = false;

      // Holding a card at the viewport edge must continue to scroll without more mouse moves.
      const beforeScroll = await evaluate('document.querySelector("#eventsList").scrollTop');
      const startPoint = await point(`${row('a')} .event-card`, 5);
      const bottom = await evaluate('document.querySelector("#eventsList").getBoundingClientRect().bottom - 8');
      const held = await beginDrag(`${row('a')} .event-card`, 0, bottom - startPoint.y, 5);
      await delay(120);
      check(await evaluate('document.querySelector("#eventsList").scrollTop') > beforeScroll, 'Перетаскивание у края не прокручивает сетку');
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await mouse('mouseReleased', held, false);
      await evaluate(`document.querySelector('#eventsList').scrollTop = ${beforeScroll}`);

      await evaluate('state.settings.viewMode = "week"; renderEvents()');
      check(await evaluate('document.querySelectorAll(".timeline-day").length === 7 && document.querySelectorAll(".all-day-events .event-row").length === 2'), 'Неделя или многодневное событие отображаются неверно');
      const width = await evaluate('document.querySelector(".timeline-day").getBoundingClientRect().width');
      await drag(`${row('a')} .event-card`, width, 20, 5);
      info = await eventInfo('a');
      check(info.day === '2026-10-06' && new Date(info.start).getHours() === 10 && new Date(info.start).getMinutes() === 15 && new Date(info.end) - new Date(info.start) === 15 * 60000, `Перенос в другой день не работает: ${JSON.stringify(info)}`);

      resetFixture();
      await evaluate('loadEvents()');
      await waitFor('!state.loading');
      await evaluate('document.querySelectorAll(".segmented button").forEach((button) => button.classList.toggle("active", button.dataset.view === "week")); document.querySelector("#toast").classList.add("hidden"); document.querySelector("#eventsList").scrollTop = 640;');
      await mouse('mouseMoved', { x: 400, y: 190 }, false);
      await snapshot('timeline-preview-week.png');
      win.setSize(600, 680);
      await delay(40);
      const sticky = await evaluate(`(() => {
        const list = document.querySelector('#eventsList'); list.scrollLeft = 0;
        const left = document.querySelector('.timeline-hours').getBoundingClientRect().left;
        list.scrollLeft = 150; list.scrollTop += 80;
        return { scrolled: list.scrollLeft > 0, stays: document.querySelector('.timeline-hours').getBoundingClientRect().left === left, headerVisible: document.querySelector('.timeline-header').getBoundingClientRect().top === list.getBoundingClientRect().top + 1, overflow: document.body.scrollWidth > innerWidth };
      })()`);
      check(sticky.scrolled && sticky.stays && sticky.headerVisible && !sticky.overflow, `Шкала времени не закреплена при прокрутке: ${JSON.stringify(sticky)}`);

      // A stationary click must still open the full editor after the drag interaction.
      win.setSize(940, 820);
      await evaluate('state.settings.viewMode = "today"; renderEvents(); document.querySelector("#eventsList").scrollTop = 640;');
      const clickPoint = await point(`${row('a')} .event-card`, 12);
      await mouse('mouseMoved', clickPoint, false); await mouse('mousePressed', clickPoint, true); await mouse('mouseReleased', clickPoint, false);
      await waitFor('!document.querySelector("#editorPage").classList.contains("hidden")');
      check(await evaluate('state.editingEvent.id === "a"'), 'Обычный клик открывает другое событие');
      await evaluate('showPage("calendar"); document.querySelector(".timeline-event[data-event-id=a] .event-card").focus({preventScroll:true})');
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: 1 });
      await delay(40); await waitFor('!state.mutationInProgress');
      info = await eventInfo('a');
      check(new Date(info.start).getHours() === 9 && new Date(info.start).getMinutes() === 15 && new Date(info.end) - new Date(info.start) === 60 * 60000, 'Перенос с клавиатуры не работает');
      await evaluate('document.querySelector(".timeline-event[data-event-id=a] .event-resize-handle").focus({preventScroll:true})');
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
      await delay(40); await waitFor('!state.mutationInProgress');
      info = await eventInfo('a');
      check(new Date(info.end) - new Date(info.start) === 45 * 60000, 'Изменение окончания с клавиатуры не работает');

      resetFixture();
      await evaluate('loadEvents()'); await waitFor('!state.loading');
      const updatesBeforeRestore = calls.length;
      await click(`${row('a')} .complete-button`);
      check(await evaluate('!document.querySelector(".timeline-event[data-event-id=a]") && state.archivedEvents.length === 1'), 'Выполненная встреча не скрылась');
      await click('.all-day-events [data-event-id="all-day"] .complete-button');
      await click('#showAllEvents');
      check(configStore.getPublicSettings().showCompletedEvents && await evaluate('document.querySelectorAll(".completed-event").length === 2 && !document.querySelector(".completed-event.draggable-event")'), 'Галочка не показывает выполненные или не сохраняется');
      await evaluate('document.querySelector("#toast").classList.add("hidden"); document.querySelectorAll(".segmented button").forEach((button) => button.classList.toggle("active", button.dataset.view === state.settings.viewMode));');
      await mouse('mouseMoved', { x: 400, y: 190 }, false);
      await snapshot('timeline-preview-completed.png');
      await click(`${row('a')} .restore-button`);
      check(await evaluate('document.querySelector(".timeline-event[data-event-id=a].draggable-event") && document.querySelector(".all-day-events [data-event-id=all-day].completed-event") && state.archivedEvents.length === 1 && document.querySelector("#editorPage").classList.contains("hidden")'), 'Возврат одного события затронул остальные или открыл редактор');
      check(calls.length === updatesBeforeRestore, 'Возврат из выполненных изменяет Google-событие');
      await click('#showAllEvents');
      check(await evaluate('!document.querySelector(".completed-event") && document.querySelector(".timeline-event[data-event-id=a]")'), 'Выключение галочки прячет восстановленное событие');
      await click('#showAllEvents');
      failRestore = true;
      await click('.all-day-events [data-event-id="all-day"] .restore-button');
      check(await evaluate('state.archivedEvents.length === 1 && document.querySelector(".all-day-events [data-event-id=all-day].completed-event") && !document.querySelector(".all-day-events [data-event-id=all-day] .restore-button").disabled'), 'Ошибка восстановления меняет архив или блокирует повторную попытку');
      failRestore = false;
      failSettings = true;
      await click('#showAllEvents');
      check(await evaluate('state.settings.showCompletedEvents && document.querySelector("#showAllEvents").checked && document.querySelector(".completed-event")'), 'Ошибка сохранения галочки не восстанавливает режим');
      failSettings = false;
      await click('.all-day-events [data-event-id="all-day"] .restore-button');
      check(archiveStore.list('team').length === 0 && await evaluate('document.querySelectorAll(".completed-event").length === 0'), 'Событие на весь день не возвращается из выполненных');
      await otherDevice.archive('team', events.find((event) => event.id === 'readonly'));
      await evaluate('refreshFromOtherDevices()');
      check(await evaluate('document.querySelector(".timeline-event[data-event-id=readonly].completed-event") && state.archivedEvents.length === 1'), 'Отметка другого устройства не появилась при фоновом обновлении');
      remote.failRead = true;
      await evaluate('refreshFromOtherDevices()');
      check(await evaluate('state.events.length === 5 && state.archivedEvents.length === 1 && document.querySelector(".timeline-event[data-event-id=readonly].completed-event")'), 'Сбой связи стирает события или отметки');
      remote.failRead = false;
      await otherDevice.restore('team', 'readonly', 'readonly');
      win.webContents.send('sync-refresh');
      await waitFor('!eventRequestsInFlight && state.archivedEvents.length === 0');
      check(await evaluate('document.querySelector(".timeline-event[data-event-id=readonly]:not(.completed-event)")'), 'Возврат с другого устройства не подхватился при открытии окна');
      await evaluate(`openEditor(state.events.find((event) => event.id === 'a'))`);
      await otherDevice.archive('team', events.find((event) => event.id === 'a'));
      await evaluate('refreshFromOtherDevices()');
      check(await evaluate('state.archivedEvents.length === 0 && !document.querySelector("#editorPage").classList.contains("hidden")'), 'Фоновое обновление мешает редактированию');
      await evaluate('showPage("calendar"); refreshFromOtherDevices()');
      check(await evaluate('state.archivedEvents.length === 1'), 'Изменение другого устройства потерялось после выхода из редактора');
      await otherDevice.restore('team', 'team', 'a');
      await evaluate('refreshFromOtherDevices()');
      await otherDevice.archive('team', events.find((event) => event.id === 'c'));
      await waitFor('state.archivedEvents.some((entry) => entry.eventId === "c")', 32000);
      check(await evaluate('document.querySelector(".timeline-event[data-event-id=c].completed-event")'), 'Автоматическое обновление каждые 30 секунд не работает');
      await otherDevice.restore('team', 'team', 'c');
      await evaluate('refreshFromOtherDevices()');
      let releaseArchiveRead;
      delayedArchiveRead = new Promise((resolve) => { releaseArchiveRead = resolve; });
      await evaluate('void refreshFromOtherDevices()');
      for (let attempt = 0; attempt < 100 && !archiveReadWaiting; attempt++) await delay(10);
      check(archiveReadWaiting, 'Не удалось задержать фоновый ответ');
      await click(`${row('a')} .complete-button`);
      delayedArchiveRead = null; releaseArchiveRead();
      await waitFor('!eventRequestsInFlight');
      check(await evaluate('state.archivedEvents.length === 1 && document.querySelector(".timeline-event[data-event-id=a].completed-event")'), 'Старый фоновый ответ отменяет новую отметку выполнения');
      await otherDevice.restore('team', 'team', 'a');
      await evaluate('refreshFromOtherDevices()');
      await evaluate(`openEditor(state.events.find((event) => event.id === 'a')); document.querySelector('#eventSummary').value = 'Изменено после синхронизации'; document.querySelector('#eventForm').requestSubmit()`);
      await waitFor('!state.mutationInProgress && !state.loading');
      check(await evaluate('state.events.some((event) => event.id === "a" && event.summary === "Изменено после синхронизации") && document.querySelector("#editorPage").classList.contains("hidden")'), 'Сохранение в редакторе не обновляет события после синхронизации');
      const addButtonAboveEvents = await evaluate(`(() => {
        state.events = [${JSON.stringify(timed('fab-overlap', 'Событие под кнопкой добавления', '09:00', '10:00'))}];
        hideError(); renderEvents(); document.querySelector('#toast').classList.add('hidden');
        const list = document.querySelector('#eventsList');
        const card = document.querySelector('.timeline-event .event-card');
        const button = document.querySelector('#addButton');
        const buttonRect = button.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const x = buttonRect.left + buttonRect.width / 2;
        const y = buttonRect.top + buttonRect.height / 2;
        list.scrollTop += cardRect.top + cardRect.height / 2 - y;
        return document.elementFromPoint(x, y) === button && document.elementsFromPoint(x, y).includes(card);
      })()`);
      check(addButtonAboveEvents, 'Событие перекрывает кнопку добавления');
      await snapshot('timeline-preview-add-button.png');
      await click('#addButton');
      await waitFor('!document.querySelector("#editorPage").classList.contains("hidden")');
      check(await evaluate('state.editingEvent === null'), 'Кнопка добавления над событием открывает его редактор вместо нового события');
      console.log('Timeline smoke OK:', { geometry, updates: calls.length, movedAcrossDays: true, resizeMinimum: 15, cancelled: true, failedUpdateRestored: true, autoScroll: true, clickOpensEditor: true, keyboard: true, sticky, showCompleted: true, restoreByMouse: true, restoreFailureKeptArchive: true, savedVisibility: true, secondDeviceCompletion: true, secondDeviceRestore: true, periodicSync: true, syncFailureKeptEvents: true, editorUninterrupted: true, staleResponseIgnored: true, editorSaveRefreshesEvents: true, addButtonAboveEvents });
      app.exit(0);
    } catch (error) {
      console.error(error.stack);
      if (win && !win.isDestroyed()) { try { await snapshot('timeline-smoke-failure.png'); } catch {} }
      app.exit(1);
    }
  });
}
