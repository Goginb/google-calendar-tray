'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electronPath = require('electron');
const packagedExecutable = process.env.CALENDAR_TRAY_SMOKE_EXECUTABLE;
const smokeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'google-calendar-tray-smoke-'));

const port = 12000 + Math.floor(Math.random() * 5000);
const child = spawn(packagedExecutable || electronPath, packagedExecutable ? [`--remote-debugging-port=${port}`, '--disable-gpu', '--no-sandbox'] : ['.', `--remote-debugging-port=${port}`, '--disable-gpu', '--no-sandbox'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, CALENDAR_TRAY_SMOKE_USER_DATA: smokeUserData },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});

let diagnostics = '';
child.stdout.on('data', (chunk) => { diagnostics += chunk; });
child.stderr.on('data', (chunk) => { diagnostics += chunk; });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findRenderer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const pages = await response.json();
      const renderer = pages.find((page) => page.type === 'page' && page.url.endsWith('/renderer/index.html'));
      if (renderer) return renderer;
    } catch {
      // Electron ещё запускается.
    }
    await delay(250);
  }
  throw new Error('Renderer не появился за 10 секунд');
}

function evaluate(webSocketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => { socket.close(); reject(new Error('CDP timeout')); }, 5000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true }
    })));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
      else resolve(message.result?.result?.value);
    });
    socket.addEventListener('error', () => reject(new Error('Не удалось подключиться к CDP')));
  });
}

async function main() {
  try {
    const renderer = await findRenderer();
    await delay(600);
    const result = await evaluate(renderer.webSocketDebuggerUrl, `(async () => {
      const appState = await window.calendarApp.getInitialState();
      return JSON.stringify({
        title: document.title,
        ready: document.readyState,
        calendarVisible: !document.querySelector('#calendarPage').classList.contains('hidden'),
        viewButtons: document.querySelectorAll('[data-view]').length,
        hasSetupAction: Boolean(document.querySelector('#bannerSetupButton')),
        hasEditor: Boolean(document.querySelector('#eventForm')),
        hasCalendarFilters: Boolean(document.querySelector('#calendarPage #calendarFilters #calendarList')),
        hasArchive: Boolean(document.querySelector('#archivePage #archiveList')),
        hasDateNavigation: Boolean(document.querySelector('#previousDateButton') && document.querySelector('#nextDateButton') && document.querySelector('#jumpTodayButton')),
        hasDeleteAction: Boolean(document.querySelector('#deleteEventButton')),
        trayReady: appState.trayReady,
        windowVisible: appState.windowVisible,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        cardBackground: getComputedStyle(document.querySelector('.settings-card')).backgroundColor,
        bodySize: [document.body.scrollWidth, document.body.scrollHeight]
      });
    })()`);
    const state = JSON.parse(result);
    if (state.title !== 'Google Calendar Tray') throw new Error(`Неверный title: ${state.title}`);
    if (state.ready !== 'complete' || !state.calendarVisible) throw new Error('Главная страница не готова');
    if (state.viewButtons !== 2 || !state.hasSetupAction || !state.hasEditor || !state.hasCalendarFilters || !state.hasDeleteAction || !state.hasArchive || !state.hasDateNavigation) throw new Error('В UI отсутствуют обязательные элементы');
    if (!state.trayReady) throw new Error('Значок системного трея не создан');
    if (state.windowVisible) throw new Error('Окно самопроизвольно открылось при запуске');
    if (state.colorScheme !== 'dark' || state.bodyBackground !== 'rgb(17, 21, 28)') throw new Error('Тёмная тема не применилась');
    const navigation = JSON.parse(await evaluate(renderer.webSocketDebuggerUrl, `(async () => {
      const today = localDate(getRange().start);
      const nextArrowBefore = document.querySelector('#nextDateButton').getBoundingClientRect().x;
      document.querySelector('#nextDateButton').click();
      const nextDay = localDate(getRange().start);
      const jumpVisible = !document.querySelector('#jumpTodayButton').classList.contains('hidden');
      const nextArrowAfter = document.querySelector('#nextDateButton').getBoundingClientRect().x;
      const jumpSeparate = document.querySelector('#jumpTodayButton').parentElement.classList.contains('date-shortcut');
      openEditor();
      const formDate = document.querySelector('#eventStartDate').value;
      showPage('calendar');
      document.querySelector('#jumpTodayButton').click();
      const returnedToday = localDate(getRange().start);
      state.settings.viewMode = 'week'; updateHeading();
      const weekStart = getRange().start;
      document.querySelector('#nextDateButton').click();
      const weekShift = Math.round((getRange().start.getTime() - weekStart.getTime()) / 86400000);
      state.settings.viewMode = 'today'; state.anchorDate = null; updateHeading();
      return JSON.stringify({ today, nextDay, jumpVisible, jumpSeparate, nextArrowBefore, nextArrowAfter, formDate, returnedToday, weekShift });
    })()`));
    if (navigation.nextDay === navigation.today || !navigation.jumpVisible || !navigation.jumpSeparate || navigation.nextArrowBefore !== navigation.nextArrowAfter || navigation.formDate !== navigation.nextDay || navigation.returnedToday !== navigation.today || navigation.weekShift !== 7) throw new Error('Навигация по дням и неделям не работает');
    const interaction = JSON.parse(await evaluate(renderer.webSocketDebuggerUrl, `(async () => {
      state.auth.signedIn = true;
      state.calendars = [
        { id: 'visible', summary: 'Видимый', primary: true, accessRole: 'owner', backgroundColor: '#4285f4' },
        { id: 'hidden', summary: 'Скрытый', accessRole: 'writer', backgroundColor: '#34a853' },
        { id: 'readonly', summary: 'Только чтение', accessRole: 'reader', backgroundColor: '#fbbc05' }
      ];
      state.settings.selectedCalendarIds = ['visible'];
      renderCalendarFilters(); renderConnection();
      const filtersInitiallyClosed = !document.querySelector('#calendarFilters').open;
      const filterSummary = document.querySelector('#calendarSelectionSummary').textContent;
      document.querySelector('#calendarFilters summary').click();
      const filtersOpened = document.querySelector('#calendarFilters').open;
      openEditor();
      const createCalendars = [...document.querySelectorAll('#eventCalendar option')].map((option) => option.value);
      document.querySelector('#eventStart').value = '2026-09-29T23:55';
      document.querySelector('#eventEnd').value = '2026-09-29T10:00';
      document.querySelector('#eventStart').dispatchEvent(new Event('input', { bubbles: true }));
      const shiftedEnd = document.querySelector('#eventEnd').value;
      document.querySelector('#eventEnd').value = '2026-09-30T00:05';
      document.querySelector('#eventEnd').dispatchEvent(new Event('change', { bubbles: true }));
      const earlierEndKept = document.querySelector('#eventEnd').value;
      document.querySelector('#eventSummary').value = 'Проверка времени';
      document.querySelector('#eventEnd').value = '2026-09-29T23:50';
      document.querySelector('#eventEnd').dispatchEvent(new Event('change', { bubbles: true }));
      let invalidEndRejected = false;
      try { buildResource(); } catch (error) { invalidEndRejected = /позже начала/.test(error.message); }
      document.querySelector('#eventEnd').value = '2026-09-30T02:00';
      document.querySelector('#eventEnd').dispatchEvent(new Event('change', { bubbles: true }));
      const chosenEnd = document.querySelector('#eventEnd').value;
      const chosenResource = buildResource();
      const chosenDurationMinutes = (new Date(chosenResource.end.dateTime) - new Date(chosenResource.start.dateTime)) / 60000;
      const sample = { id: 'event-42', calendarId: 'visible', summary: 'Встреча', start: { dateTime: '2026-09-24T10:00:00+03:00' }, end: { dateTime: '2026-09-24T11:00:00+03:00' }, attendees: [{ email: 'colleague@example.com', responseStatus: 'accepted' }] };
      openEditor(sample);
      document.querySelector('#eventEnd').value = '2026-09-24T12:30';
      document.querySelector('#eventEnd').dispatchEvent(new Event('change', { bubbles: true }));
      const editActions = {
        saveLabel: document.querySelector('#saveEventButton').textContent,
        deleteVisible: !document.querySelector('#deleteEventButton').classList.contains('hidden'),
        leavesUnchangedGuests: !('attendees' in buildResource()),
        chosenEnd: document.querySelector('#eventEnd').value
      };
      addGuest('new@example.com');
      editActions.changedGuests = buildResource().attendees;
      document.querySelector('#deleteEventButton').click();
      const deleteConfirmationVisible = !document.querySelector('#confirmDialog').classList.contains('hidden');
      document.querySelector('#confirmCancelButton').click();
      document.querySelector('#eventSummary').value = 'Изменено';
      document.querySelector('#editorBackButton').click();
      const discardConfirmationVisible = !document.querySelector('#confirmDialog').classList.contains('hidden');
      document.querySelector('#confirmCancelButton').click();
      return JSON.stringify({
        filters: document.querySelectorAll('#calendarList input[type=checkbox]').length,
        filtersInitiallyClosed, filtersOpened, filterSummary, shiftedEnd, earlierEndKept, invalidEndRejected, chosenEnd, chosenDurationMinutes,
        createCalendars,
        editActions,
        deleteConfirmationVisible,
        discardConfirmationVisible,
        editorStillVisible: !document.querySelector('#editorPage').classList.contains('hidden')
      });
    })()`));
    if (interaction.filters !== 3 || interaction.createCalendars.join(',') !== ',visible,hidden') throw new Error('Календари не отображаются или скрытый календарь недоступен при создании');
    if (!interaction.filtersInitiallyClosed || !interaction.filtersOpened || interaction.filterSummary !== 'Выбрано 1 из 3') throw new Error('Панель выбора календарей не сворачивается');
    if (interaction.shiftedEnd !== '2026-09-30T00:10' || interaction.earlierEndKept !== '2026-09-30T00:05' || !interaction.invalidEndRejected || interaction.chosenEnd !== '2026-09-30T02:00' || interaction.chosenDurationMinutes !== 125) throw new Error('Выбранное время окончания подменяется или не проверяется');
    if (interaction.editActions.saveLabel !== 'Сохранить изменения' || !interaction.editActions.deleteVisible || !interaction.editActions.leavesUnchangedGuests || interaction.editActions.chosenEnd !== '2026-09-24T12:30' || interaction.editActions.changedGuests[0]?.responseStatus !== 'accepted' || interaction.editActions.changedGuests[1]?.email !== 'new@example.com') throw new Error('Действия редактирования или сохранение гостей не работают');
    if (!interaction.deleteConfirmationVisible || !interaction.discardConfirmationVisible || !interaction.editorStillVisible) throw new Error('Подтверждение изменений не работает');
    const reschedule = JSON.parse(await evaluate(renderer.webSocketDebuggerUrl, `(async () => {
      showPage('calendar');
      state.anchorDate = new Date('2026-09-30T00:00:00');
      state.settings.viewMode = 'today';
      state.events = [
        { id: 'timed', calendarId: 'visible', summary: 'Встреча', start: { dateTime: '2026-09-30T10:00:00+03:00' }, end: { dateTime: '2026-09-30T11:30:00+03:00' } },
        { id: 'all-day', calendarId: 'visible', summary: 'Командировка', start: { date: '2026-09-30' }, end: { date: '2026-10-02' } },
        { id: 'readonly', calendarId: 'readonly', summary: 'Чужое событие', start: { date: '2026-09-30' }, end: { date: '2026-10-01' } }
      ];
      renderEvents();
      const cards = ['timed', 'all-day', 'readonly'].map((id) => document.querySelector('#eventsList [data-event-id="' + id + '"] .event-card'));
      cards[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
      const menuVisible = !document.querySelector('#eventContextMenu').classList.contains('hidden');
      document.querySelector('#rescheduleMenuItem').click();
      const dialogVisible = !document.querySelector('#rescheduleDialog').classList.contains('hidden');
      const timedDate = document.querySelector('#rescheduleDate').value;
      const timedTime = document.querySelector('#rescheduleTime').value;
      const timedFieldVisible = !document.querySelector('#rescheduleTimeField').classList.contains('hidden');
      document.querySelector('#rescheduleCancelButton').click();
      cards[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
      document.querySelector('#rescheduleMenuItem').click();
      const allDayDate = document.querySelector('#rescheduleDate').value;
      const allDayTimeHidden = document.querySelector('#rescheduleTimeField').classList.contains('hidden');
      document.querySelector('#rescheduleCancelButton').click();
      cards[2].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
      const readonlyMenuHidden = document.querySelector('#eventContextMenu').classList.contains('hidden');
      return JSON.stringify({ menuVisible, dialogVisible, timedDate, timedTime, timedFieldVisible, allDayDate, allDayTimeHidden, readonlyMenuHidden });
    })()`));
    if (!reschedule.menuVisible || !reschedule.dialogVisible || reschedule.timedDate !== '2026-09-30' || reschedule.timedTime !== '10:00' || !reschedule.timedFieldVisible || reschedule.allDayDate !== '2026-09-30' || !reschedule.allDayTimeHidden || !reschedule.readonlyMenuHidden) throw new Error('Перенос события через ПКМ не работает');
    const contacts = JSON.parse(await evaluate(renderer.webSocketDebuggerUrl, `(async () => {
      showPage('calendar');
      document.querySelector('#contactsButton').click();
      const bookOpened = !document.querySelector('#contactsPage').classList.contains('hidden');
      const addFormHiddenByDefault = document.querySelector('#contactForm').classList.contains('hidden');
      document.querySelector('#contactSearch').value = 'Colleague@example.com';
      document.querySelector('#contactSearch').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#contactsList .contact-create').click();
      document.querySelector('#contactName').value = 'Тестовый коллега';
      document.querySelector('#contactForm').requestSubmit();
      for (let i = 0; i < 50 && state.contacts.length !== 58; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      const persisted = await window.calendarApp.listContacts();
      document.querySelector('#contactsBackButton').click();
      openEditor();
      const input = document.querySelector('#guestInput');
      const nextFieldBefore = document.querySelector('#eventAllDay').getBoundingClientRect().top;
      input.value = 'Игорь Огибин';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const igorMatches = [...document.querySelectorAll('#guestSuggestions button')].some((button) => button.textContent.includes('greshtus@gmail.com'));
      const popupAnchored = getComputedStyle(document.querySelector('#guestSuggestions')).position === 'absolute' && Math.abs(document.querySelector('#guestSuggestions').getBoundingClientRect().top - input.getBoundingClientRect().bottom) <= 8 && document.querySelector('#eventAllDay').getBoundingClientRect().top === nextFieldBefore;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const enterSelected = state.guests.includes('greshtus@gmail.com');
      document.querySelector('#guestChips button[aria-label="Убрать гостя greshtus@gmail.com"]').click();
      input.value = 'Александр Кайгородов';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const reverseNameMatches = [...document.querySelectorAll('#guestSuggestions button')].some((button) => button.textContent.includes('kaygorodov.alex@gmail.com'));
      input.value = 'Тестовый';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const suggestionVisible = !document.querySelector('#guestSuggestions').classList.contains('hidden');
      document.querySelector('#guestSuggestions button').click();
      document.querySelector('#eventSummary').value = 'Тестовая встреча';
      const attendees = buildResource().attendees;
      document.querySelector('#openContactsButton').click();
      const bookSelectVisible = Boolean(document.querySelector('#contactsList .secondary'));
      document.querySelector('#contactsBackButton').click();
      const guestKept = state.guests.includes('colleague@example.com');
      input.value = 'jane.doe@example.com';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#guestSuggestions .new-contact-option').click();
      const guessedName = document.querySelector('#contactName').value;
      document.querySelector('#contactName').value = 'Джейн Доу';
      document.querySelector('#contactForm').requestSubmit();
      for (let i = 0; i < 50 && !state.guests.includes('jane.doe@example.com'); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      const newContactSelected = !document.querySelector('#editorPage').classList.contains('hidden') && state.guests.includes('jane.doe@example.com') && state.contacts.some((contact) => contact.email === 'jane.doe@example.com' && contact.name === 'Джейн Доу');
      state.contacts = await window.calendarApp.rememberContacts(['new@example.com', 'colleague@example.com']);
      const remembered = await window.calendarApp.listContacts();
      return JSON.stringify({ bookOpened, addFormHiddenByDefault, persistedCount: persisted.length, savedContact: persisted.some((contact) => contact.name === 'Тестовый коллега'), igorMatches, popupAnchored, enterSelected, reverseNameMatches, suggestionVisible, attendees, bookSelectVisible, guestKept, guessedName, newContactSelected, rememberedCount: remembered.length });
    })()`));
    if (!contacts.bookOpened || !contacts.addFormHiddenByDefault || contacts.persistedCount !== 58 || !contacts.savedContact || !contacts.igorMatches || !contacts.popupAnchored || !contacts.enterSelected || !contacts.reverseNameMatches || !contacts.suggestionVisible || contacts.attendees[0]?.email !== 'colleague@example.com' || !contacts.bookSelectVisible || !contacts.guestKept || contacts.guessedName !== 'Jane Doe' || !contacts.newContactSelected || contacts.rememberedCount !== 60) throw new Error('Адресная книга или выбор гостей не работают');
    const archive = JSON.parse(await evaluate(renderer.webSocketDebuggerUrl, `(async () => {
      state.archiveAccountId = 'smoke-account';
      state.settings.viewMode = 'today'; state.settings.showCompletedEvents = false;
      state.settings.selectedCalendarIds = ['visible', 'readonly']; state.anchorDate = null;
      const day = localDate(new Date());
      const yesterday = new Date(day + 'T00:00'); yesterday.setDate(yesterday.getDate() - 1);
      const current = { id: 'done', calendarId: 'visible', summary: 'Выполненная встреча', description: 'Комментарий', start: { dateTime: new Date(day + 'T09:00').toISOString() }, end: { dateTime: new Date(day + 'T10:00').toISOString() } };
      state.events = [current];
      state.archivedEvents = [
        { ...current, eventId: current.id, archivedAt: new Date().toISOString() },
        { calendarId: 'visible', eventId: 'older', summary: 'Вчера', start: { date: localDate(yesterday) }, archivedAt: new Date().toISOString() }
      ];
      showPage('calendar'); renderConnection(); renderEvents();
      const hiddenCompleted = document.querySelectorAll('#eventsList .event-row').length === 0;
      const todayCount = document.querySelector('#archiveCount').textContent;
      document.querySelector('#archiveButton').click();
      const archiveVisible = document.querySelectorAll('#archiveList .archive-card').length === 1;
      state.anchorDate = yesterday; renderEvents(); renderArchive();
      const yesterdayCount = document.querySelector('#archiveCount').textContent;
      const yesterdayVisible = document.querySelectorAll('#archiveList .archive-card').length === 1;
      state.anchorDate = null; showPage('calendar'); renderEvents();
      document.querySelector('#showAllEvents').click();
      for (let i = 0; i < 100 && document.querySelector('#showAllEvents').disabled; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      const completedVisible = !!document.querySelector('.completed-event .has-description');
      const completedCannotDrag = !document.querySelector('.completed-event.draggable-event');
      const savedPreference = (await window.calendarApp.getInitialState()).settings.showCompletedEvents;
      document.querySelector('.restore-button').click();
      for (let i = 0; i < 100 && state.mutationInProgress; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      const restoreFailureKeptArchive = state.archivedEvents.length === 2 && !!document.querySelector('.completed-event') && !document.querySelector('.restore-button').disabled;
      const errorShown = !document.querySelector('#errorState').classList.contains('hidden');
      return JSON.stringify({ hiddenCompleted, todayCount, archiveVisible, yesterdayCount, yesterdayVisible, completedVisible, completedCannotDrag, savedPreference, restoreFailureKeptArchive, errorShown });
    })()`));
    if (!archive.hiddenCompleted || archive.todayCount !== '1' || !archive.archiveVisible || archive.yesterdayCount !== '1' || !archive.yesterdayVisible || !archive.completedVisible || !archive.completedCannotDrag || !archive.savedPreference || !archive.restoreFailureKeptArchive || !archive.errorShown) throw new Error('Интерфейс выполненных или обработка недоступной синхронизации не работает: ' + JSON.stringify(archive));
    console.log('Smoke OK:', { ...state, navigation, interaction, reschedule, contacts, archive });
  } finally {
    if (child.pid) {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      child.kill('SIGKILL');
    }
    await delay(1500);
    try {
      fs.rmSync(smokeUserData, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    } catch (error) {
      console.warn(`Не удалось удалить временные данные smoke-теста: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  if (diagnostics.trim()) console.error(diagnostics.trim());
  process.exitCode = 1;
});
