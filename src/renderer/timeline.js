'use strict';

const TIMELINE_HELP = 'Перетащите событие для переноса; нижний край — для изменения длительности. Шаг — 15 минут.';
const PIXELS_PER_MINUTE = window.TimelineUtils.HOUR_HEIGHT / 60;
const timelineScrollPositions = new Map();
let activeTimelineGesture = null;

function timelineDays() {
  const { start, end } = getRange();
  const days = [];
  for (const date = new Date(start); date < end; date.setDate(date.getDate() + 1)) days.push(new Date(date));
  return days;
}

function formatTimelineTime(event) {
  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);
  const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
  return localDate(start) === localDate(end)
    ? `${time.format(start)}–${time.format(end)}`
    : `${date.format(start)}, ${time.format(start)} — ${date.format(end)}, ${time.format(end)}`;
}

function setTimelineCardTime(row, event, segment) {
  row.querySelector('.event-time').textContent = state.settings.viewMode === 'week'
    ? `${pad(Math.floor(segment.startMinute / 60))}:${pad(Math.floor(segment.startMinute % 60))}${segment.startsHere ? '' : ' ↳'}`
    : formatTimelineTime(event);
}

function renderTimeline(events) {
  cancelTimelineGesture();
  const list = $('#eventsList');
  if (list.dataset.rangeKey) timelineScrollPositions.set(list.dataset.rangeKey, { top: list.scrollTop, left: list.scrollLeft });
  const days = timelineDays();
  const rangeKey = `${state.settings.viewMode}:${localDate(days[0])}`;
  const calendar = document.createElement('div'); calendar.className = 'time-calendar';
  calendar.style.setProperty('--day-count', String(days.length));
  calendar.style.setProperty('--hour-height', `${window.TimelineUtils.HOUR_HEIGHT}px`);
  calendar.classList.toggle('week-calendar', days.length > 1);
  const header = document.createElement('div'); header.className = 'timeline-header';
  const headings = document.createElement('div'); headings.className = 'timeline-headings';
  const timezone = document.createElement('div'); timezone.className = 'timeline-corner';
  timezone.textContent = new Intl.DateTimeFormat('ru-RU', { timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((part) => part.type === 'timeZoneName')?.value || '';
  timezone.title = `Часовой пояс: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  headings.append(timezone);
  const allDay = document.createElement('div'); allDay.className = 'timeline-all-day';
  const allDayLabel = document.createElement('div'); allDayLabel.className = 'timeline-corner'; allDayLabel.textContent = 'Весь день';
  allDay.append(allDayLabel);
  const body = document.createElement('div'); body.className = 'timeline-body';
  const hours = document.createElement('div'); hours.className = 'timeline-hours';
  hours.setAttribute('aria-label', 'Часовая шкала');
  for (let hour = 0; hour <= 24; hour++) {
    const label = document.createElement('span'); label.className = 'hour-label';
    label.textContent = `${pad(hour)}:00`; label.style.top = `${hour * window.TimelineUtils.HOUR_HEIGHT}px`;
    hours.append(label);
  }
  body.append(hours);
  let earliestMinute = 8 * 60;
  for (const day of days) {
    const dayKey = localDate(day);
    const heading = document.createElement('div'); heading.className = 'timeline-day-heading';
    heading.classList.toggle('is-today', dayKey === localDate(new Date()));
    const weekday = document.createElement('span'); weekday.textContent = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(day);
    const number = document.createElement('strong'); number.textContent = String(day.getDate());
    heading.append(weekday, number); headings.append(heading);
    const allDayEvents = document.createElement('div'); allDayEvents.className = 'all-day-events';
    for (const event of events.filter((item) => item.start?.date <= dayKey && item.end?.date > dayKey)) allDayEvents.append(createEventCard(event));
    allDay.append(allDayEvents);
    const column = document.createElement('div'); column.className = 'timeline-day'; column.dataset.date = dayKey;
    column.setAttribute('aria-label', new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full' }).format(day));
    for (const segment of window.TimelineUtils.layoutSegments(window.TimelineUtils.timedSegments(events, day))) {
      earliestMinute = Math.min(earliestMinute, Math.max(0, segment.startMinute - 60));
      const row = createEventCard(segment.event); row.classList.add('timeline-event');
      const card = row.querySelector('.event-card');
      const rangeText = formatTimelineTime(segment.event);
      card.title = `${segment.event.summary || '(Без названия)'} · ${rangeText}\n${card.title}`;
      card.setAttribute('aria-label', `${segment.event.summary || '(Без названия)'}, ${rangeText}${completedEntryFor(segment.event) ? ', выполнено' : ''}`);
      setTimelineCardTime(row, segment.event, segment);
      row.style.setProperty('--event-color', calendarById(segment.event.calendarId)?.backgroundColor || '#4285f4');
      positionTimelineEvent(row, segment);
      const writable = !completedEntryFor(segment.event) && ['owner', 'writer'].includes(calendarById(segment.event.calendarId)?.accessRole);
      if (writable) {
        row.classList.add('draggable-event');
        card.title += '\nПеретащите для переноса. Alt + стрелки — перенос с клавиатуры.';
        if (segment.endsHere) {
          const resize = document.createElement('button'); resize.type = 'button'; resize.className = 'event-resize-handle';
          resize.title = 'Потяните, чтобы изменить окончание. Стрелки ↑ ↓ — шаг 15 минут.';
          resize.setAttribute('aria-label', `Изменить длительность: ${segment.event.summary || '(Без названия)'}`);
          resize.addEventListener('click', (event) => event.stopPropagation());
          resize.addEventListener('keydown', (event) => changeTimelineWithKeyboard(event, segment.event, 'resize'));
          row.append(resize);
        }
        card.addEventListener('keydown', (event) => { if (event.altKey) changeTimelineWithKeyboard(event, segment.event, 'move'); });
        row.addEventListener('pointerdown', (pointer) => startTimelineGesture(pointer, row, segment, day));
      }
      row.addEventListener('click', (event) => {
        if (row.suppressClickUntil > performance.now()) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, true);
      column.append(row);
    }
    body.append(column);
  }
  header.append(headings, allDay);
  calendar.append(header, body);
  list.replaceChildren(calendar); list.dataset.rangeKey = rangeKey;
  $('#timelineHelp').textContent = TIMELINE_HELP;
  updateNowIndicators();
  const scroll = timelineScrollPositions.get(rangeKey);
  list.scrollTop = scroll?.top ?? earliestMinute * PIXELS_PER_MINUTE;
  list.scrollLeft = scroll?.left ?? 0;
  // Keep a bounded set of visited dates during long-running tray sessions.
  if (timelineScrollPositions.size > 30) timelineScrollPositions.delete(timelineScrollPositions.keys().next().value);
}

function positionTimelineEvent(row, segment) {
  const height = Math.max(1, (segment.endMinute - segment.startMinute) * PIXELS_PER_MINUTE);
  row.style.top = `${segment.startMinute * PIXELS_PER_MINUTE}px`;
  row.style.height = `${height}px`;
  row.style.left = `calc(${100 * (segment.column || 0) / (segment.columns || 1)}% + 2px)`;
  row.style.width = `calc(${100 / (segment.columns || 1)}% - 4px)`;
  row.classList.toggle('short-event', height < 52);
  row.classList.toggle('tiny-event', height < 32);
}

function updateNowIndicators() {
  $$('.now-line').forEach((line) => line.remove());
  const now = new Date();
  const column = $(`.timeline-day[data-date="${localDate(now)}"]`);
  if (!column) return;
  const line = document.createElement('div'); line.className = 'now-line';
  line.style.top = `${window.TimelineUtils.minutesOfDay(now) * PIXELS_PER_MINUTE}px`;
  line.title = `Сейчас ${new Intl.DateTimeFormat('ru-RU', { timeStyle: 'short' }).format(now)}`;
  column.append(line);
}

function timelineIsWritable(event) {
  return state.auth.signedIn && !state.loading && !state.mutationInProgress && !completedEntryFor(event) && ['owner', 'writer'].includes(calendarById(event.calendarId)?.accessRole);
}

async function saveTimelineChange(event, resource, kind) {
  if (!timelineIsWritable(event)) return;
  if (new Date(resource.start.dateTime).getTime() === new Date(event.start.dateTime).getTime() && new Date(resource.end.dateTime).getTime() === new Date(event.end.dateTime).getTime()) return;
  beginEventMutation();
  const list = $('#eventsList'); list.classList.add('is-saving'); list.setAttribute('aria-busy', 'true');
  $('#timelineHelp').textContent = 'Сохраняю время в Google Calendar…';
  try {
    const updated = await window.calendarApp.updateEvent({ calendarId: event.calendarId, eventId: event.id, resource });
    state.events = state.events.map((item) => eventKey(item.calendarId, item.id) === eventKey(event.calendarId, event.id)
      ? { ...item, ...resource, ...updated, id: event.id, calendarId: event.calendarId } : item);
    showToast(kind === 'resize' ? 'Длительность изменена' : 'Событие перенесено');
  } catch (error) {
    showToast(`Не удалось сохранить время: ${messageFrom(error)}`);
  } finally {
    state.mutationInProgress = false;
    list.classList.remove('is-saving');
    renderEvents();
  }
}

function changeTimelineWithKeyboard(key, event, kind) {
  if (!timelineIsWritable(event) || activeTimelineGesture) return;
  const vertical = { ArrowUp: -15, ArrowDown: 15 }[key.key];
  const horizontal = kind === 'move' ? { ArrowLeft: -1, ArrowRight: 1 }[key.key] : undefined;
  if (vertical === undefined && horizontal === undefined) return;
  key.preventDefault(); key.stopPropagation();
  const resource = window.TimelineUtils.buildTimelineResource(event, { kind, minutes: vertical || 0, days: horizontal || 0 });
  saveTimelineChange(event, resource, kind).then(() => {
    const row = $$('.timeline-event').find((item) => item.dataset.eventId === event.id && item.dataset.calendarId === event.calendarId);
    row?.querySelector(kind === 'resize' ? '.event-resize-handle' : '.event-card')?.focus({ preventScroll: true });
  });
}

function cancelTimelineGesture() { activeTimelineGesture?.cancel(); }

function startTimelineGesture(pointer, row, segment, sourceDay) {
  if (pointer.button !== 0 || !pointer.isPrimary || pointer.target.closest('.complete-button') || !timelineIsWritable(segment.event)) return;
  cancelTimelineGesture();
  closeEventContextMenu();
  const kind = pointer.target.closest('.event-resize-handle') ? 'resize' : 'move';
  const list = $('#eventsList');
  const columns = $$('.timeline-day');
  const sourceColumn = row.parentElement;
  const anchorMinute = kind === 'move' ? segment.startMinute : segment.endMinute;
  const grabOffset = (pointer.clientY - sourceColumn.getBoundingClientRect().top) / PIXELS_PER_MINUTE - anchorMinute;
  let last = { x: pointer.clientX, y: pointer.clientY };
  let moved = false;
  let preview = null;
  let frame = 0;
  const ghosts = [];

  function drawPreview() {
    const target = columns.find((column) => {
      const rect = column.getBoundingClientRect(); return last.x >= rect.left && last.x <= rect.right;
    });
    const viewport = list.getBoundingClientRect();
    const headerBottom = $('.timeline-header').getBoundingClientRect().bottom;
    if (!target || last.y < headerBottom || last.y > viewport.bottom || last.x < viewport.left || last.x > viewport.right) {
      preview = null;
      ghosts.splice(0).forEach((ghost) => ghost.remove());
      $('#timelineHelp').textContent = 'Отпустите внутри часовой сетки. Escape — отменить перенос.';
      return;
    }
    const targetDay = new Date(`${target.dataset.date}T00:00:00`);
    const minute = Math.max(0, Math.min(1440, window.TimelineUtils.snapMinute((last.y - target.getBoundingClientRect().top) / PIXELS_PER_MINUTE - grabOffset)));
    preview = window.TimelineUtils.buildTimelineResource(segment.event, {
      kind, days: window.TimelineUtils.dayOffset(sourceDay, targetDay), minutes: minute - anchorMinute
    });
    ghosts.splice(0).forEach((ghost) => ghost.remove());
    const previewEvent = { ...segment.event, ...preview };
    for (const column of columns) {
      const visible = window.TimelineUtils.timedSegments([previewEvent], new Date(`${column.dataset.date}T00:00:00`))[0];
      if (!visible) continue;
      const ghost = row.cloneNode(true); ghost.classList.remove('drag-origin'); ghost.classList.add('timeline-ghost');
      ghost.removeAttribute('data-event-id'); ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
      setTimelineCardTime(ghost, previewEvent, visible);
      positionTimelineEvent(ghost, visible); column.append(ghost); ghosts.push(ghost);
    }
    const duration = Math.round((new Date(preview.end.dateTime) - new Date(preview.start.dateTime)) / 60000);
    $('#timelineHelp').textContent = `${formatTimelineTime(previewEvent)} · ${duration} мин. · Escape — отменить`;
  }

  function scrollFrame() {
    if (!moved) return;
    const rect = list.getBoundingClientRect();
    const top = $('.timeline-header').getBoundingClientRect().bottom;
    if (last.x >= rect.left && last.x <= rect.right && last.y >= top - 8 && last.y <= rect.bottom + 8) {
      const edge = 40;
      const vertical = last.y < top + edge ? -Math.min(16, (top + edge - last.y) / 3) : last.y > rect.bottom - edge ? Math.min(16, (last.y - rect.bottom + edge) / 3) : 0;
      const horizontal = last.x < rect.left + 70 ? -8 : last.x > rect.right - edge ? 8 : 0;
      if (vertical || horizontal) { list.scrollTop += vertical; list.scrollLeft += horizontal; drawPreview(); }
    }
    frame = requestAnimationFrame(scrollFrame);
  }

  function move(next) {
    if (next.pointerId !== pointer.pointerId) return;
    last = { x: next.clientX, y: next.clientY };
    if (!moved && Math.hypot(last.x - pointer.clientX, last.y - pointer.clientY) < 5) return;
    if (!moved) {
      moved = true; row.classList.add('drag-origin'); list.classList.add('is-dragging');
      row.setPointerCapture(pointer.pointerId); frame = requestAnimationFrame(scrollFrame);
    }
    next.preventDefault(); drawPreview();
  }

  function cleanup() {
    cancelAnimationFrame(frame);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', cancel);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', cancel);
    row.removeEventListener('lostpointercapture', cancel);
    if (row.hasPointerCapture(pointer.pointerId)) row.releasePointerCapture(pointer.pointerId);
    ghosts.splice(0).forEach((ghost) => ghost.remove());
    row.classList.remove('drag-origin'); list.classList.remove('is-dragging');
    if (moved) row.suppressClickUntil = performance.now() + 500;
    activeTimelineGesture = null;
    $('#timelineHelp').textContent = TIMELINE_HELP;
  }

  function finish(next) {
    if (next.pointerId !== pointer.pointerId) return;
    if (moved) { last = { x: next.clientX, y: next.clientY }; drawPreview(); }
    const resource = preview;
    cleanup();
    if (moved && resource) saveTimelineChange(segment.event, resource, kind);
  }
  function cancel() { cleanup(); }
  function onKey(key) { if (key.key === 'Escape') { key.preventDefault(); key.stopImmediatePropagation(); cancel(); } }
  activeTimelineGesture = { cancel };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', cancel);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', cancel);
  row.addEventListener('lostpointercapture', cancel);
}

setInterval(updateNowIndicators, 60000);
