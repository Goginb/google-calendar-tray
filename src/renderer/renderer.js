'use strict';

const state = {
  auth: { credentialsConfigured: false, signedIn: false },
  settings: { selectedCalendarIds: [], calendarSelectionInitialized: false, viewMode: 'today' },
  calendars: [],
  events: [],
  archivedEvents: [],
  contacts: [],
  guests: [],
  contactsReturnPage: 'calendar',
  editingContactEmail: '',
  selectNewContactForGuest: false,
  archiveAccountId: '',
  anchorDate: null,
  editingEvent: null,
  contextEvent: null,
  contextTrigger: null,
  reschedulingEvent: null,
  rescheduleTrigger: null,
  loading: false,
  mutationInProgress: false
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let toastTimer;
let eventsRequestId = 0;
let editorSnapshot = '';

function pad(value) { return String(value).padStart(2, '0'); }
function localDate(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
function localDateTime(date) { return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
function startOfDay(date = new Date()) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function getRange() {
  const start = startOfDay(state.anchorDate || new Date());
  if (state.settings.viewMode === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(end.getDate() + (state.settings.viewMode === 'week' ? 7 : 1));
  return { timeMin: start.toISOString(), timeMax: end.toISOString(), start, end };
}

function messageFrom(error) {
  return error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, '') || 'Неизвестная ошибка';
}

function showPage(name) {
  $$('.page').forEach((page) => page.classList.add('hidden'));
  $(`#${name}Page`).classList.remove('hidden');
  if (name === 'settings') renderSettings();
  if (name === 'archive') renderArchive();
  if (name === 'contacts') { renderContacts(); $('#contactSearch').focus(); }
  if (name === 'editor') renderGuestSuggestions();
}

function contactByEmail(email) {
  return state.contacts.find((contact) => contact.email === email);
}

function matchesContact(contact, value) {
  const parts = value.trim().toLocaleLowerCase('ru').split(/\s+/).filter(Boolean);
  const searchable = `${contact.name.toLocaleLowerCase('ru')} ${contact.email}`;
  return parts.every((part) => searchable.includes(part));
}

function openContacts(fromEditor = false) {
  state.contactsReturnPage = fromEditor ? 'editor' : 'calendar';
  $('#contactSearch').value = '';
  resetContactForm();
  showPage('contacts');
}

function resetContactForm() {
  $('#contactForm').reset();
  $('#contactForm').classList.add('hidden');
  $('#contactEmail').disabled = false;
  $('#saveContactButton').textContent = 'Сохранить контакт';
  $('#contactError').classList.add('hidden');
  state.editingContactEmail = '';
  state.selectNewContactForGuest = false;
}

function startContactCreation(email, selectForGuest = false) {
  resetContactForm();
  $('#contactSearch').value = email;
  $('#contactFormTitle').textContent = 'Новый контакт';
  $('#contactEmail').value = email;
  $('#contactName').value = window.ContactUtils.guessNameFromEmail(email);
  state.selectNewContactForGuest = selectForGuest;
  $('#contactForm').classList.remove('hidden');
  renderContacts();
  $('#contactName').focus();
}

function startContactEdit(contact) {
  resetContactForm();
  state.editingContactEmail = contact.email;
  $('#contactFormTitle').textContent = 'Изменить имя';
  $('#contactName').value = contact.name;
  $('#contactEmail').value = contact.email;
  $('#contactEmail').disabled = true;
  $('#saveContactButton').textContent = 'Сохранить имя';
  $('#contactForm').classList.remove('hidden');
  $('#contactName').focus();
}

function renderContacts() {
  const list = $('#contactsList');
  list.replaceChildren();
  const query = $('#contactSearch').value.trim();
  const matches = state.contacts.filter((contact) => matchesContact(contact, query));
  if (!matches.length) {
    const empty = document.createElement('p');
    empty.className = 'contact-empty';
    empty.textContent = query ? 'Контакт не найден' : 'Контактов пока нет';
    list.append(empty);
  }
  if (window.ContactUtils.validEmail(query) && !contactByEmail(window.ContactUtils.normalizeEmail(query)) && $('#contactForm').classList.contains('hidden')) {
    const create = document.createElement('button'); create.type = 'button'; create.className = 'secondary contact-create';
    create.textContent = `Сохранить новый адрес ${query}`;
    create.addEventListener('click', () => startContactCreation(query, state.contactsReturnPage === 'editor'));
    list.append(create);
  }
  for (const contact of matches) {
    const row = document.createElement('div'); row.className = 'contact-row';
    const details = document.createElement('div'); details.className = 'contact-details';
    const name = document.createElement('strong'); name.textContent = contact.name || contact.email;
    details.append(name);
    if (contact.name) {
      const email = document.createElement('span'); email.textContent = contact.email; details.append(email);
    }
    row.append(details);
    if (state.contactsReturnPage === 'editor') {
      const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'secondary'; choose.textContent = 'Выбрать';
      choose.addEventListener('click', () => { addGuest(contact.email); showPage('editor'); });
      row.append(choose);
    }
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon-button'; edit.textContent = '✎'; edit.title = 'Изменить имя'; edit.setAttribute('aria-label', `Изменить ${contact.name || contact.email}`);
    edit.addEventListener('click', () => startContactEdit(contact));
    row.append(edit);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.textContent = '×'; remove.title = 'Удалить контакт'; remove.setAttribute('aria-label', `Удалить ${contact.name || contact.email}`);
    remove.addEventListener('click', async () => {
      if (!await confirmAction('Удалить контакт?', `${contact.name || contact.email} будет удалён из адресной книги.`, 'Удалить')) return;
      try {
        state.contacts = await window.calendarApp.removeContact(contact.email);
        if (state.editingContactEmail === contact.email) resetContactForm();
        renderContacts(); renderGuestChips(); renderGuestSuggestions();
      } catch (error) { showToast(messageFrom(error)); }
    });
    row.append(remove);
    list.append(row);
  }
}

async function saveContact(event) {
  event.preventDefault();
  const button = $('#saveContactButton'); button.disabled = true;
  $('#contactError').classList.add('hidden');
  try {
    const email = $('#contactEmail').value;
    const selectForGuest = state.selectNewContactForGuest;
    state.contacts = await window.calendarApp.saveContact({ name: $('#contactName').value, email });
    $('#contactSearch').value = email;
    resetContactForm(); renderContacts(); renderGuestChips(); renderGuestSuggestions();
    if (selectForGuest) { addGuest(email); showPage('editor'); $('#guestInput').focus(); }
    showToast('Контакт сохранён');
  } catch (error) {
    $('#contactError').textContent = messageFrom(error);
    $('#contactError').classList.remove('hidden');
  } finally { button.disabled = false; }
}

function addGuest(email) {
  const normalized = window.ContactUtils.normalizeEmail(email);
  if (!window.ContactUtils.validEmail(normalized)) throw new Error('Введите корректную почту гостя');
  if (!state.guests.includes(normalized)) state.guests.push(normalized);
  $('#guestInput').value = '';
  renderGuestChips(); renderGuestSuggestions();
}

function addGuestFromInput() {
  const value = $('#guestInput').value.trim();
  if (!value) return;
  const enteredName = value.toLocaleLowerCase('ru').split(/\s+/).sort().join(' ');
  const exact = state.contacts.filter((contact) => contact.email === window.ContactUtils.normalizeEmail(value) ||
    contact.name.toLocaleLowerCase('ru').split(/\s+/).sort().join(' ') === enteredName);
  if (exact.length === 1) addGuest(exact[0].email);
  else if (exact.length > 1) throw new Error('Найдено несколько контактов с этим именем. Выберите нужного из списка.');
  else addGuest(value);
}

function renderGuestChips() {
  const list = $('#guestChips'); list.replaceChildren();
  for (const email of state.guests) {
    const chip = document.createElement('div'); chip.className = 'guest-chip';
    const label = document.createElement('span'); label.textContent = contactByEmail(email)?.name || email; label.title = email;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Убрать гостя ${email}`);
    remove.addEventListener('click', () => { state.guests = state.guests.filter((value) => value !== email); renderGuestChips(); renderGuestSuggestions(); });
    chip.append(label, remove); list.append(chip);
  }
}

function renderGuestSuggestions() {
  const list = $('#guestSuggestions'); list.replaceChildren();
  const query = $('#guestInput').value.trim();
  if (!query || $('#editorPage').classList.contains('hidden')) {
    list.classList.add('hidden');
    $('#guestInput').setAttribute('aria-expanded', 'false');
    return;
  }
  const matches = state.contacts.filter((contact) => !state.guests.includes(contact.email) && matchesContact(contact, query));
  for (const contact of matches) {
    const option = document.createElement('button'); option.type = 'button'; option.setAttribute('role', 'option');
    const name = document.createElement('span'); name.textContent = contact.name || contact.email;
    option.append(name);
    if (contact.name) { const email = document.createElement('small'); email.textContent = contact.email; option.append(email); }
    option.addEventListener('click', () => addGuest(contact.email));
    list.append(option);
  }
  const email = window.ContactUtils.normalizeEmail(query);
  if (window.ContactUtils.validEmail(email) && !contactByEmail(email) && !state.guests.includes(email)) {
    const create = document.createElement('button'); create.type = 'button'; create.className = 'new-contact-option'; create.setAttribute('role', 'option');
    const label = document.createElement('span'); label.textContent = `Добавить ${email}`;
    const hint = document.createElement('small');
    const guessedName = window.ContactUtils.guessNameFromEmail(email);
    hint.textContent = guessedName ? `Имя: ${guessedName} — можно исправить` : 'Можно указать имя';
    create.append(label, hint);
    create.addEventListener('click', () => { openContacts(true); startContactCreation(email, true); });
    list.append(create);
  }
  if (!list.children.length) {
    const empty = document.createElement('span'); empty.className = 'contact-empty'; empty.textContent = 'Контакт не найден'; list.append(empty);
  }
  list.classList.remove('hidden');
  $('#guestInput').setAttribute('aria-expanded', 'true');
}

function updateHeading() {
  const { start, end } = getRange();
  const today = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  if (state.settings.viewMode === 'today') $('#dateHeading').textContent = today.format(start);
  else {
    const endInclusive = new Date(end); endInclusive.setDate(endInclusive.getDate() - 1);
    const short = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
    const withYear = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
    $('#dateHeading').textContent = `${start.getFullYear() === endInclusive.getFullYear() ? short.format(start) : withYear.format(start)} — ${withYear.format(endInclusive)}`;
  }
  const currentStart = startOfDay();
  if (state.settings.viewMode === 'week') currentStart.setDate(currentStart.getDate() - ((currentStart.getDay() + 6) % 7));
  $('#jumpTodayButton').classList.toggle('hidden', start.getTime() === currentStart.getTime());
  const previous = state.settings.viewMode === 'week' ? 'Предыдущая неделя' : 'Предыдущий день';
  const next = state.settings.viewMode === 'week' ? 'Следующая неделя' : 'Следующий день';
  $('#previousDateButton').title = previous;
  $('#previousDateButton').setAttribute('aria-label', previous);
  $('#nextDateButton').title = next;
  $('#nextDateButton').setAttribute('aria-label', next);
}

function shiftVisibleDate(direction) {
  state.anchorDate = window.CalendarUtils.shiftCalendarDate(state.anchorDate || new Date(), state.settings.viewMode, direction);
  loadEvents();
}

function jumpToToday() {
  state.anchorDate = null;
  loadEvents();
}

function calendarById(id) { return state.calendars.find((calendar) => calendar.id === id); }
function eventKey(calendarId, eventId) { return JSON.stringify([calendarId, eventId]); }
function completedForVisiblePeriod() {
  const { start, end } = getRange();
  return window.CalendarUtils.archivedEventsInRange(state.archivedEvents, start, end);
}

function renderArchiveCount() {
  const count = completedForVisiblePeriod().length;
  const period = $('#dateHeading').textContent;
  $('#archiveCount').textContent = String(count);
  $('#archiveButton').title = `Показать выполненные события: ${period}`;
  $('#archiveButton').setAttribute('aria-label', `Выполнено за ${period}: ${count}`);
}

function renderEvents() {
  updateHeading();
  renderArchiveCount();
  const list = $('#eventsList');
  list.replaceChildren();
  const archivedKeys = new Set(state.archivedEvents.map((entry) => eventKey(entry.calendarId, entry.eventId)));
  const visibleEvents = state.events.filter((event) => !archivedKeys.has(eventKey(event.calendarId, event.id)));
  $('#loadingState').classList.toggle('hidden', !state.loading);
  $('#emptyState').classList.toggle('hidden', state.loading || visibleEvents.length > 0 || !state.auth.signedIn);
  const noSelection = state.settings.selectedCalendarIds.length === 0;
  $('#emptyTitle').textContent = noSelection ? 'Выберите календарь' : 'Свободно';
  $('#emptyDescription').textContent = noSelection ? 'Отметьте нужные календари выше' : 'В этом периоде событий нет';
  if (state.loading) return;

  const groups = new Map();
  for (const event of visibleEvents) {
    const start = new Date(event.start.dateTime || `${event.start.date}T00:00:00`);
    const key = localDate(start);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }

  for (const [, events] of groups) {
    const group = document.createElement('section');
    group.className = 'day-group';
    if (state.settings.viewMode === 'week') {
      const date = new Date(events[0].start.dateTime || `${events[0].start.date}T00:00:00`);
      const label = document.createElement('div');
      label.className = 'day-label';
      label.textContent = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
      group.append(label);
    }
    for (const event of events) group.append(createEventCard(event));
    list.append(group);
  }
}

function createEventCard(event) {
  const calendar = calendarById(event.calendarId);
  const writable = ['owner', 'writer'].includes(calendar?.accessRole);
  const hasDescription = typeof event.description === 'string' && event.description.trim().length > 0;
  const row = document.createElement('div');
  row.className = 'event-row';
  const card = document.createElement(writable ? 'button' : 'div');
  card.className = 'event-card';
  card.classList.toggle('readonly', !writable);
  card.classList.toggle('has-description', hasDescription);
  card.title = `${writable ? 'ЛКМ: открыть · ПКМ: действия' : 'Календарь доступен только для чтения'}${hasDescription ? ' · Есть описание' : ''}`;
  const color = document.createElement('span');
  color.className = 'event-color';
  color.style.backgroundColor = calendar?.backgroundColor || '#1a73e8';
  const time = document.createElement('span');
  time.className = 'event-time';
  time.textContent = event.start.date ? 'Весь день' : new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(event.start.dateTime));
  const copy = document.createElement('span');
  copy.className = 'event-copy';
  const title = document.createElement('span');
  title.className = 'event-title';
  title.textContent = event.summary || '(Без названия)';
  const meta = document.createElement('span');
  meta.className = 'event-meta';
  meta.textContent = [hasDescription ? '✎ Описание' : '', event.location, calendar?.summary].filter(Boolean).join(' · ');
  copy.append(title, meta);
  card.append(color, time, copy);
  if (writable) {
    card.addEventListener('click', () => openEditor(event));
    card.addEventListener('contextmenu', (mouseEvent) => {
      mouseEvent.preventDefault();
      openEventContextMenu(event, card, mouseEvent.clientX, mouseEvent.clientY);
    });
  }
  const complete = document.createElement('button');
  complete.type = 'button';
  complete.className = 'complete-button';
  complete.textContent = '✓';
  complete.disabled = !state.archiveAccountId;
  complete.title = complete.disabled ? 'Архив недоступен: не найден основной календарь' : 'Отметить выполненным и отправить в архив';
  complete.setAttribute('aria-label', `Отметить выполненным: ${event.summary || '(Без названия)'}`);
  complete.addEventListener('click', () => markCompleted(event, complete));
  row.append(card, complete);
  return row;
}

function closeEventContextMenu() {
  $('#eventContextMenu').classList.add('hidden');
  state.contextEvent = null;
  state.contextTrigger = null;
}

function openEventContextMenu(event, trigger, x, y) {
  if (state.mutationInProgress) return;
  state.contextEvent = event;
  state.contextTrigger = trigger;
  const menu = $('#eventContextMenu');
  menu.classList.remove('hidden');
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
  $('#rescheduleMenuItem').focus();
}

function openRescheduleDialog(event) {
  state.rescheduleTrigger = state.contextTrigger;
  closeEventContextMenu();
  state.reschedulingEvent = event;
  const allDay = Boolean(event.start?.date);
  const start = allDay ? null : new Date(event.start?.dateTime);
  $('#rescheduleDate').value = allDay ? event.start.date : localDate(start);
  $('#rescheduleTime').value = allDay ? '' : `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  $('#rescheduleTimeField').classList.toggle('hidden', allDay);
  $('#rescheduleTime').required = !allDay;
  $('#rescheduleError').classList.add('hidden');
  $('#rescheduleSaveButton').disabled = false;
  $('#rescheduleSaveButton').textContent = 'Перенести';
  document.querySelector('header').inert = true;
  document.querySelector('main').inert = true;
  $('#rescheduleDialog').classList.remove('hidden');
  $('#rescheduleDate').focus();
}

function closeRescheduleDialog() {
  if (state.mutationInProgress) return;
  $('#rescheduleDialog').classList.add('hidden');
  document.querySelector('header').inert = false;
  document.querySelector('main').inert = false;
  state.reschedulingEvent = null;
  state.rescheduleTrigger?.focus();
  state.rescheduleTrigger = null;
}

async function saveReschedule(event) {
  event.preventDefault();
  if (state.mutationInProgress || !state.reschedulingEvent) return;
  state.mutationInProgress = true;
  const button = $('#rescheduleSaveButton');
  button.disabled = true;
  button.textContent = 'Перенос…';
  $('#rescheduleError').classList.add('hidden');
  try {
    const target = state.reschedulingEvent;
    const resource = window.CalendarUtils.buildRescheduleResource(target, $('#rescheduleDate').value, $('#rescheduleTime').value);
    await window.calendarApp.updateEvent({ calendarId: target.calendarId, eventId: target.id, resource });
    state.mutationInProgress = false;
    closeRescheduleDialog();
    showToast('Событие перенесено');
    await loadEvents();
  } catch (error) {
    $('#rescheduleError').textContent = messageFrom(error);
    $('#rescheduleError').classList.remove('hidden');
  } finally {
    state.mutationInProgress = false;
    button.disabled = false;
    button.textContent = 'Перенести';
  }
}

function renderArchive() {
  const list = $('#archiveList');
  list.replaceChildren();
  const entries = completedForVisiblePeriod();
  $('#archivePeriod').textContent = state.settings.viewMode === 'week'
    ? `За неделю: ${$('#dateHeading').textContent}`
    : `За день: ${$('#dateHeading').textContent}`;
  $('#archiveEmpty').classList.toggle('hidden', entries.length > 0);
  $('#archiveEmptyDescription').textContent = state.settings.viewMode === 'week'
    ? 'За выбранную неделю выполненных событий нет'
    : 'За выбранный день выполненных событий нет';
  renderArchiveCount();
  for (const entry of entries) {
    const card = document.createElement('article');
    card.className = 'archive-card';
    const main = document.createElement('div');
    main.className = 'archive-card-main';
    const dot = document.createElement('span');
    dot.className = 'calendar-dot';
    dot.style.backgroundColor = entry.calendarColor;
    const copy = document.createElement('div');
    copy.className = 'archive-card-copy';
    const title = document.createElement('strong');
    title.className = 'event-title';
    title.textContent = entry.summary;
    const meta = document.createElement('span');
    meta.className = 'event-meta';
    const rawDate = entry.start?.dateTime || (entry.start?.date ? `${entry.start.date}T00:00:00` : '');
    const date = new Date(rawDate);
    const formatted = Number.isNaN(date.getTime()) ? 'Дата неизвестна' : new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric', month: 'long', year: 'numeric',
      ...(entry.start?.dateTime ? { hour: '2-digit', minute: '2-digit' } : {})
    }).format(date);
    meta.textContent = [formatted, entry.calendarSummary, entry.location].filter(Boolean).join(' · ');
    copy.append(title, meta);
    main.append(dot, copy);
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'link-button';
    restore.textContent = 'Вернуть в общий список';
    restore.addEventListener('click', () => restoreCompleted(entry, restore));
    card.append(main, restore);
    list.append(card);
  }
}

async function markCompleted(event, button) {
  if (state.mutationInProgress || !state.archiveAccountId) return;
  state.mutationInProgress = true;
  button.disabled = true;
  try {
    const calendar = calendarById(event.calendarId);
    state.archivedEvents = await window.calendarApp.archiveEvent(state.archiveAccountId, {
      id: event.id,
      calendarId: event.calendarId,
      summary: event.summary,
      location: event.location,
      start: event.start,
      calendarSummary: calendar?.summary,
      calendarColor: calendar?.backgroundColor
    });
    renderEvents();
    renderArchive();
    showToast('Событие перемещено в «Выполнено»');
  } catch (error) {
    button.disabled = false;
    showError(messageFrom(error));
  } finally {
    state.mutationInProgress = false;
  }
}

async function restoreCompleted(entry, button) {
  if (state.mutationInProgress || !state.archiveAccountId) return;
  state.mutationInProgress = true;
  button.disabled = true;
  try {
    state.archivedEvents = await window.calendarApp.restoreArchivedEvent(state.archiveAccountId, entry.calendarId, entry.eventId);
    renderArchive();
    renderEvents();
    showToast('Отметка «Выполнено» снята');
  } catch (error) {
    button.disabled = false;
    showError(messageFrom(error));
  } finally {
    state.mutationInProgress = false;
  }
}

async function loadCalendars() {
  if (!state.auth.signedIn) return;
  try {
    state.calendars = await window.calendarApp.listCalendars();
    if (!state.settings.calendarSelectionInitialized) {
      const primary = state.calendars.find((calendar) => calendar.primary);
      state.settings.selectedCalendarIds = primary ? [primary.id] : state.calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id);
      state.settings.calendarSelectionInitialized = true;
      await saveSettings();
    } else {
      const validIds = state.settings.selectedCalendarIds.filter((id) => state.calendars.some((calendar) => calendar.id === id));
      if (validIds.length !== state.settings.selectedCalendarIds.length) {
        state.settings.selectedCalendarIds = validIds;
        await saveSettings();
      }
    }
    state.archiveAccountId = state.calendars.find((calendar) => calendar.primary)?.id || '';
    try {
      state.archivedEvents = state.archiveAccountId ? await window.calendarApp.listArchive(state.archiveAccountId) : [];
    } catch (error) {
      state.archivedEvents = [];
      showToast(`Не удалось открыть архив: ${messageFrom(error)}`);
    }
    renderCalendarFilters();
    renderConnection();
  } catch (error) {
    showError(messageFrom(error));
    if (/invalid_grant|unauthorized|Login Required/i.test(messageFrom(error))) {
      state.auth.signedIn = false;
      state.archiveAccountId = '';
      state.archivedEvents = [];
      renderConnection();
    }
  }
}

async function loadEvents() {
  const requestId = ++eventsRequestId;
  renderConnection();
  if (!state.auth.signedIn || !state.settings.selectedCalendarIds.length) {
    state.loading = false;
    state.events = [];
    hideError();
    renderEvents();
    return;
  }
  state.loading = true;
  hideError();
  renderEvents();
  try {
    const range = getRange();
    const events = await window.calendarApp.listEvents({
      calendarIds: [...state.settings.selectedCalendarIds],
      timeMin: range.timeMin,
      timeMax: range.timeMax
    });
    if (requestId === eventsRequestId) state.events = events;
  } catch (error) {
    if (requestId === eventsRequestId) {
      showError(messageFrom(error));
      state.events = [];
    }
  } finally {
    if (requestId === eventsRequestId) {
      state.loading = false;
      renderEvents();
    }
  }
}

function renderConnection() {
  $('#connectionBanner').classList.toggle('hidden', state.auth.signedIn);
  $('#calendarFilters').classList.toggle('hidden', !state.auth.signedIn);
  $('#addButton').classList.toggle('hidden', !state.auth.signedIn);
  $('#addButton').disabled = writableCalendars().length === 0;
  $('#addButton').title = $('#addButton').disabled ? 'Нет календарей с правом записи' : 'Новое событие';
  $('#archiveButton').classList.toggle('hidden', !state.auth.signedIn || !state.archiveAccountId);
  renderArchiveCount();
}

function renderSettings() {
  const credentials = state.auth.credentialsConfigured;
  const signedIn = state.auth.signedIn;
  const status = $('#authStatus');
  status.className = `status-row${signedIn ? ' good' : ''}`;
  status.textContent = signedIn ? '● Аккаунт подключён' : credentials ? 'OAuth-файл настроен — войдите в Google' : 'OAuth-файл пока не добавлен';
  $('#signInButton').classList.toggle('hidden', !credentials || signedIn);
  $('#signOutButton').classList.toggle('hidden', !signedIn);
  $('#oauthGuide').classList.toggle('hidden', credentials || signedIn);
  $('#importButton').textContent = credentials ? 'Заменить OAuth JSON' : 'Импортировать JSON';
}

function renderCalendarFilters() {
  const list = $('#calendarList');
  list.replaceChildren();
  renderCalendarSelectionSummary();
  if (!state.calendars.length) {
    const hint = document.createElement('span'); hint.className = 'muted'; hint.textContent = 'Календари не найдены. Нажмите «Обновить»'; list.append(hint); return;
  }
  for (const calendar of state.calendars) {
    const label = document.createElement('label'); label.className = 'calendar-option';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = state.settings.selectedCalendarIds.includes(calendar.id);
    const dot = document.createElement('span'); dot.className = 'calendar-dot'; dot.style.backgroundColor = calendar.backgroundColor;
    const name = document.createElement('span'); name.className = 'calendar-name'; name.textContent = calendar.summary;
    const role = document.createElement('span'); role.className = 'calendar-role'; role.textContent = calendar.primary ? 'основной' : '';
    checkbox.addEventListener('change', async () => {
      const previous = [...state.settings.selectedCalendarIds];
      const ids = new Set(state.settings.selectedCalendarIds);
      checkbox.checked ? ids.add(calendar.id) : ids.delete(calendar.id);
      state.settings.selectedCalendarIds = [...ids];
      state.settings.calendarSelectionInitialized = true;
      renderCalendarSelectionSummary();
      try {
        await saveSettings();
        await loadEvents();
      } catch (error) {
        state.settings.selectedCalendarIds = previous;
        checkbox.checked = previous.includes(calendar.id);
        renderCalendarSelectionSummary();
        showError(messageFrom(error));
      }
    });
    label.append(checkbox, dot, name, role); list.append(label);
  }
}

function renderCalendarSelectionSummary() {
  const selected = state.calendars.filter((calendar) => state.settings.selectedCalendarIds.includes(calendar.id)).length;
  $('#calendarSelectionSummary').textContent = state.calendars.length
    ? selected ? `Выбрано ${selected} из ${state.calendars.length}` : 'Ничего не выбрано'
    : 'Нет календарей';
}

function writableCalendars() {
  return state.calendars.filter((calendar) => ['owner', 'writer'].includes(calendar.accessRole));
}

function openEditor(event = null) {
  state.editingEvent = event;
  state.guests = window.ContactUtils.normalizeGuestEmails((event?.attendees || [])
    .map((attendee) => attendee.email).filter(window.ContactUtils.validEmail));
  $('#guestInput').value = '';
  $('#guestSuggestions').classList.add('hidden');
  $('#editorTitle').textContent = event ? 'Редактировать событие' : 'Новое событие';
  $('#editorSubtitle').textContent = event ? 'Проверьте изменения перед сохранением' : 'Заполните данные и выберите календарь';
  $('#eventSummary').value = event?.summary || '';
  $('#eventLocation').value = event?.location || '';
  $('#eventDescription').value = event?.description || '';
  const select = $('#eventCalendar'); select.replaceChildren();
  const calendars = event ? state.calendars.filter((calendar) => calendar.id === event.calendarId) : writableCalendars();
  if (!event) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Выберите календарь';
    select.append(placeholder);
  }
  for (const calendar of calendars) {
    const option = document.createElement('option'); option.value = calendar.id; option.textContent = calendar.primary ? `${calendar.summary} (основной)` : calendar.summary; select.append(option);
  }
  select.value = event?.calendarId || '';
  select.disabled = Boolean(event);

  const allDay = Boolean(event?.start?.date);
  $('#eventAllDay').checked = allDay;
  if (event) {
    if (allDay) {
      $('#eventStartDate').value = event.start.date;
      const exclusiveEnd = new Date(`${event.end.date}T00:00:00`); exclusiveEnd.setDate(exclusiveEnd.getDate() - 1);
      $('#eventEndDate').value = localDate(exclusiveEnd);
      $('#eventStart').value = `${event.start.date}T09:00`;
      $('#eventEnd').value = `${event.start.date}T10:00`;
    } else {
      const start = new Date(event.start.dateTime);
      const end = new Date(event.end.dateTime);
      $('#eventStart').value = localDateTime(start);
      $('#eventEnd').value = localDateTime(end);
      $('#eventStartDate').value = localDate(start);
      $('#eventEndDate').value = localDate(end);
    }
  } else {
    const selectedDay = startOfDay(state.anchorDate || new Date());
    const isToday = selectedDay.getTime() === startOfDay().getTime();
    const start = isToday ? new Date() : selectedDay;
    if (isToday) start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0);
    else start.setHours(9, 0, 0, 0);
    const end = new Date(start); end.setHours(end.getHours() + 1);
    $('#eventStart').value = localDateTime(start);
    $('#eventEnd').value = localDateTime(end);
    $('#eventStartDate').value = localDate(start);
    $('#eventEndDate').value = localDate(start);
  }
  $('#saveEventButton').textContent = event ? 'Сохранить изменения' : 'Создать событие';
  $('#deleteEventButton').classList.toggle('hidden', !event);
  toggleAllDayFields(); hideFormError();
  renderGuestChips();
  editorSnapshot = formSnapshot();
  showPage('editor');
}

function formSnapshot() {
  return JSON.stringify([
    $('#eventSummary').value, $('#eventCalendar').value, $('#eventAllDay').checked,
    $('#eventStart').value, $('#eventEnd').value, $('#eventStartDate').value,
    $('#eventEndDate').value, $('#eventLocation').value, $('#eventDescription').value,
    state.guests, $('#guestInput').value
  ]);
}

function confirmAction(title, message, actionText, destructive = true) {
  const dialog = $('#confirmDialog');
  const previousFocus = document.activeElement;
  $('#confirmTitle').textContent = title;
  $('#confirmMessage').textContent = message;
  $('#confirmActionButton').textContent = actionText;
  $('#confirmActionButton').className = destructive ? 'danger' : 'primary';
  document.querySelector('header').inert = true;
  document.querySelector('main').inert = true;
  dialog.classList.remove('hidden');
  $('#confirmCancelButton').focus();
  return new Promise((resolve) => {
    const cancel = () => finish(false);
    const accept = () => finish(true);
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } };
    const finish = (answer) => {
      dialog.classList.add('hidden');
      document.querySelector('header').inert = false;
      document.querySelector('main').inert = false;
      $('#confirmCancelButton').removeEventListener('click', cancel);
      $('#confirmActionButton').removeEventListener('click', accept);
      document.removeEventListener('keydown', onKey);
      previousFocus?.focus();
      resolve(answer);
    };
    $('#confirmCancelButton').addEventListener('click', cancel);
    $('#confirmActionButton').addEventListener('click', accept);
    document.addEventListener('keydown', onKey);
  });
}

async function leaveEditor(page = 'calendar') {
  if (state.mutationInProgress) return;
  if (!$('#editorPage').classList.contains('hidden') && formSnapshot() !== editorSnapshot) {
    const confirmed = await confirmAction('Отменить изменения?', 'Несохранённые изменения события будут потеряны.', 'Не сохранять');
    if (!confirmed) return;
  }
  showPage(page);
}

function toggleAllDayFields() {
  const allDay = $('#eventAllDay').checked;
  $('#timedFields').classList.toggle('hidden', allDay);
  $('#allDayFields').classList.toggle('hidden', !allDay);
  $('#eventStart').required = !allDay; $('#eventEnd').required = !allDay;
  $('#eventStartDate').required = allDay; $('#eventEndDate').required = allDay;
  if (!allDay) adjustTimedEnd();
}

function adjustTimedEnd() {
  if ($('#eventAllDay').checked) return;
  const end = $('#eventEnd');
  end.value = window.CalendarUtils.clampEndDateTime($('#eventStart').value, end.value);
}

function buildResource() {
  const allDay = $('#eventAllDay').checked;
  const resource = window.CalendarUtils.buildEventResource({
    summary: $('#eventSummary').value.trim(),
    location: $('#eventLocation').value.trim(),
    description: $('#eventDescription').value.trim(),
    attendees: state.guests,
    allDay,
    startDate: $('#eventStartDate').value,
    endDate: $('#eventEndDate').value,
    startDateTime: $('#eventStart').value,
    endDateTime: $('#eventEnd').value,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });
  if (!state.editingEvent) {
    if (!resource.attendees.length) delete resource.attendees;
    return resource;
  }
  const previous = new Map((state.editingEvent.attendees || [])
    .filter((attendee) => window.ContactUtils.validEmail(attendee.email))
    .map((attendee) => [window.ContactUtils.normalizeEmail(attendee.email), attendee]));
  const before = [...previous.keys()].sort().join('\n');
  const after = resource.attendees.map((attendee) => attendee.email).sort().join('\n');
  if (before === after) delete resource.attendees;
  else resource.attendees = resource.attendees.map((attendee) => {
    const old = previous.get(attendee.email);
    return old ? {
      email: attendee.email,
      ...(old.responseStatus ? { responseStatus: old.responseStatus } : {}),
      ...(old.optional ? { optional: true } : {})
    } : attendee;
  });
  return resource;
}

async function saveEvent(event) {
  event.preventDefault();
  if (state.mutationInProgress) return;
  state.mutationInProgress = true;
  hideFormError();
  const wasEditing = Boolean(state.editingEvent);
  const button = $('#saveEventButton'); button.disabled = true; button.textContent = 'Сохранение…';
  $('#deleteEventButton').disabled = true;
  try {
    addGuestFromInput();
    const args = { calendarId: $('#eventCalendar').value, resource: buildResource() };
    if (!args.calendarId) throw new Error('Нет выбранного календаря с правом записи');
    if (state.editingEvent) await window.calendarApp.updateEvent({ ...args, eventId: state.editingEvent.id });
    else await window.calendarApp.createEvent(args);
    let contactsWarning = '';
    try {
      state.contacts = await window.calendarApp.rememberContacts(state.guests);
    } catch (error) { contactsWarning = ` Не удалось сохранить гостей в адресной книге: ${messageFrom(error)}`; }
    state.editingEvent = null;
    showPage('calendar');
    const destination = calendarById(args.calendarId)?.summary || args.calendarId;
    const hidden = !state.settings.selectedCalendarIds.includes(args.calendarId);
    showToast((wasEditing ? 'Изменения сохранены' : hidden ? `Событие создано в «${destination}». Включите календарь на главной, чтобы увидеть его.` : 'Событие создано') + contactsWarning);
    await loadEvents();
  } catch (error) {
    showFormError(messageFrom(error));
  } finally {
    button.disabled = false; button.textContent = wasEditing ? 'Сохранить изменения' : 'Создать событие';
    $('#deleteEventButton').disabled = false;
    state.mutationInProgress = false;
  }
}

async function deleteEvent() {
  if (state.mutationInProgress) return;
  const event = state.editingEvent;
  if (!event) return;
  const calendar = calendarById(event.calendarId);
  const subject = event.summary || '(Без названия)';
  const detail = event.recurringEventId ? 'Будет удалён только этот экземпляр повторяющегося события.' : 'Это действие нельзя отменить.';
  const confirmed = await confirmAction('Удалить событие?', `«${subject}» из календаря «${calendar?.summary || event.calendarId}».\n${detail}`, 'Удалить событие');
  if (!confirmed) return;
  state.mutationInProgress = true;
  const button = $('#deleteEventButton');
  button.disabled = true;
  button.textContent = 'Удаление…';
  $('#saveEventButton').disabled = true;
  hideFormError();
  try {
    await window.calendarApp.deleteEvent({ calendarId: event.calendarId, eventId: event.id });
    state.editingEvent = null;
    showPage('calendar');
    showToast('Событие удалено');
    await loadEvents();
  } catch (error) {
    showFormError(messageFrom(error));
  } finally {
    button.disabled = false;
    button.textContent = 'Удалить событие';
    $('#saveEventButton').disabled = false;
    state.mutationInProgress = false;
  }
}

async function saveSettings() { await window.calendarApp.saveSettings(state.settings); }
function showError(text) {
  if (!$('#calendarPage').classList.contains('hidden')) {
    $('#errorState').textContent = text;
    $('#errorState').classList.remove('hidden');
    return;
  }
  showToast(text);
}
function showToast(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 6000);
}
function hideError() { $('#errorState').classList.add('hidden'); }
function showFormError(text) { $('#formError').textContent = text; $('#formError').classList.remove('hidden'); }
function hideFormError() { $('#formError').classList.add('hidden'); }

async function importCredentials() {
  try {
    const result = await window.calendarApp.importCredentials();
    if (result) { state.auth = result; renderSettings(); }
  } catch (error) { showError(messageFrom(error)); }
}

async function signIn() {
  const button = $('#signInButton'); button.disabled = true; button.textContent = 'Ожидание браузера…';
  try {
    await window.calendarApp.signIn();
    state.auth.signedIn = true;
    await loadCalendars(); renderSettings(); await loadEvents();
  } catch (error) { showError(messageFrom(error)); }
  finally { button.disabled = false; button.textContent = 'Войти через Google'; }
}

async function init() {
  const initial = await window.calendarApp.getInitialState();
  state.auth = initial.auth; state.settings = initial.settings;
  state.contacts = await window.calendarApp.listContacts();
  $('#versionLabel').textContent = `Google Calendar Tray · ${initial.appVersion}`;
  $$('.segmented button').forEach((button) => button.classList.toggle('active', button.dataset.view === state.settings.viewMode));
  bindEvents(); renderConnection(); updateHeading();
  if (state.auth.signedIn) await loadCalendars();
  renderSettings(); renderCalendarFilters(); renderConnection(); await loadEvents();
}

function bindEvents() {
  $('#rescheduleMenuItem').addEventListener('click', () => {
    const event = state.contextEvent;
    if (event) openRescheduleDialog(event);
  });
  $('#rescheduleForm').addEventListener('submit', saveReschedule);
  $('#rescheduleCancelButton').addEventListener('click', closeRescheduleDialog);
  document.addEventListener('pointerdown', (event) => {
    if (!$('#eventContextMenu').contains(event.target)) closeEventContextMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#rescheduleDialog').classList.contains('hidden')) {
      event.preventDefault();
      closeRescheduleDialog();
    } else {
      const trigger = state.contextTrigger;
      closeEventContextMenu();
      trigger?.focus();
    }
  });
  document.addEventListener('scroll', closeEventContextMenu, true);
  window.addEventListener('blur', closeEventContextMenu);
  $('#closeButton').addEventListener('click', () => window.calendarApp.hideWindow());
  $('#contactsButton').addEventListener('click', async () => {
    state.contactsReturnPage = 'calendar';
    $('#contactSearch').value = '';
    resetContactForm();
    await leaveEditor('contacts');
  });
  $('#contactsBackButton').addEventListener('click', () => {
    showPage(state.contactsReturnPage);
    if (state.contactsReturnPage === 'editor') $('#guestInput').focus();
  });
  $('#contactForm').addEventListener('submit', saveContact);
  $('#contactSearch').addEventListener('input', () => { resetContactForm(); renderContacts(); });
  $('#cancelContactButton').addEventListener('click', () => { resetContactForm(); renderContacts(); });
  $('#openContactsButton').addEventListener('click', () => openContacts(true));
  $('#guestInput').addEventListener('focus', renderGuestSuggestions);
  $('#guestInput').addEventListener('input', renderGuestSuggestions);
  $('#guestInput').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { $('#guestSuggestions').classList.add('hidden'); $('#guestInput').setAttribute('aria-expanded', 'false'); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); $('#guestSuggestions button')?.focus(); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = $('#guestSuggestions:not(.hidden) button');
    if (first) { first.click(); hideFormError(); return; }
    try { addGuestFromInput(); hideFormError(); } catch (error) { showFormError(messageFrom(error)); }
  });
  $('#settingsButton').addEventListener('click', () => leaveEditor('settings'));
  $('#settingsBackButton').addEventListener('click', () => showPage('calendar'));
  $('#archiveButton').addEventListener('click', () => showPage('archive'));
  $('#archiveBackButton').addEventListener('click', () => showPage('calendar'));
  $('#editorBackButton').addEventListener('click', () => leaveEditor('calendar'));
  $('#bannerSetupButton').addEventListener('click', () => showPage('settings'));
  $('#refreshButton').addEventListener('click', loadEvents);
  $('#previousDateButton').addEventListener('click', () => shiftVisibleDate(-1));
  $('#nextDateButton').addEventListener('click', () => shiftVisibleDate(1));
  $('#jumpTodayButton').addEventListener('click', jumpToToday);
  $('#addButton').addEventListener('click', () => openEditor());
  $('#eventAllDay').addEventListener('change', toggleAllDayFields);
  $('#eventStart').addEventListener('input', adjustTimedEnd);
  $('#eventForm').addEventListener('submit', saveEvent);
  $('#deleteEventButton').addEventListener('click', deleteEvent);
  $('#importButton').addEventListener('click', importCredentials);
  $('#signInButton').addEventListener('click', signIn);
  $('#signOutButton').addEventListener('click', async () => {
    await window.calendarApp.signOut(); state.auth.signedIn = false; state.calendars = []; state.events = []; state.archivedEvents = []; state.archiveAccountId = ''; renderSettings(); renderCalendarFilters(); renderConnection(); renderEvents();
  });
  $('#reloadCalendarsButton').addEventListener('click', async () => { await loadCalendars(); await loadEvents(); });
  $('#openGoogleCloudButton').addEventListener('click', () => window.calendarApp.openExternal('https://console.cloud.google.com/apis/credentials'));
  $$('.segmented button').forEach((button) => button.addEventListener('click', async () => {
    state.settings.viewMode = button.dataset.view;
    $$('.segmented button').forEach((item) => item.classList.toggle('active', item === button));
    await saveSettings(); await loadEvents();
  }));
  window.calendarApp.onNavigate((page) => leaveEditor(page));
}

init().catch((error) => showError(messageFrom(error)));
