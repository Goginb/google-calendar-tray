'use strict';

const crypto = require('node:crypto');
const CALENDAR_DESCRIPTION = 'Google Calendar Tray completion sync v1';
const RECORD_TYPE = 'gctCompletion';

function entryKey(entry) {
  return JSON.stringify([entry.calendarId, entry.eventId || entry.id]);
}

function recordId(entry) {
  // Hex is a subset of the base32hex alphabet allowed by Google event IDs.
  return 'gct' + crypto.createHash('sha256').update(entryKey(entry)).digest('hex');
}

function isSyncCalendar(calendar) {
  return String(calendar.description || '').startsWith(CALENDAR_DESCRIPTION + '\nAccount: ');
}

function boundedText(value, fallback = '') {
  let result = '';
  let bytes = 0;
  for (const character of String(value || fallback)) {
    bytes += Buffer.byteLength(character, 'utf8');
    if (bytes > 1024) break;
    result += character;
  }
  return result;
}

function recordResource(entry, completed, origin = 'user') {
  if (typeof entry?.calendarId !== 'string' || !entry.calendarId ||
      typeof (entry.eventId || entry.id) !== 'string' || !(entry.eventId || entry.id)) throw new Error('Не выбрано событие');
  const props = {
    [RECORD_TYPE]: '1',
    calendarId: entry.calendarId,
    eventId: entry.eventId || entry.id,
    state: completed ? 'done' : 'active',
    origin,
    archivedAt: entry.archivedAt || new Date().toISOString(),
    sourceDate: entry.start?.date || '',
    sourceDateTime: entry.start?.dateTime || '',
    calendarSummary: boundedText(entry.calendarSummary, entry.calendarId),
    calendarColor: entry.calendarColor || '#4285f4'
  };
  if (Buffer.byteLength(props.calendarId, 'utf8') > 1024 || Buffer.byteLength(props.eventId, 'utf8') > 1024) {
    throw new Error('Слишком длинный идентификатор события');
  }
  return {
    summary: boundedText(entry.summary, '(Без названия)'),
    location: boundedText(entry.location),
    // All records stay in a hidden, separate calendar and never occupy busy time.
    start: { date: '1970-01-01' }, end: { date: '1970-01-02' },
    transparency: 'transparent', visibility: 'private',
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: props }
  };
}

function parseRecord(event, recordCalendarId) {
  const props = event.extendedProperties?.private;
  if (event.status === 'cancelled' || props?.[RECORD_TYPE] !== '1' ||
      !props.calendarId || !props.eventId || !['done', 'active'].includes(props.state) ||
      event.id !== recordId(props)) return null;
  return {
    calendarId: props.calendarId, eventId: props.eventId,
    summary: event.summary || '(Без названия)', location: event.location || '',
    start: { date: props.sourceDate || null, dateTime: props.sourceDateTime || null },
    calendarSummary: props.calendarSummary || props.calendarId,
    calendarColor: props.calendarColor || '#4285f4',
    archivedAt: props.archivedAt || event.updated || '',
    completed: props.state === 'done', origin: props.origin || 'user',
    updated: event.updated || '', recordCalendarId
  };
}

function mergeRecord(records, next) {
  if (!next) return;
  const key = entryKey(next);
  const previous = records.get(key);
  // A migration from an old device can never resurrect a task restored by a user.
  const wins = !previous ||
    (previous.origin === 'legacy' && next.origin !== 'legacy') ||
    ((previous.origin === 'legacy') === (next.origin === 'legacy') &&
      (next.updated > previous.updated ||
       (next.updated === previous.updated && next.recordCalendarId < previous.recordCalendarId)));
  if (wins) records.set(key, next);
}

module.exports = { CALENDAR_DESCRIPTION, RECORD_TYPE, entryKey, recordId, isSyncCalendar, recordResource, parseRecord, mergeRecord };
