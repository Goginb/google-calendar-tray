'use strict';

const contactsForCalendar = typeof module !== 'undefined' && module.exports
  ? require('./contact-utils') : window.ContactUtils;

function pad(value) {
  return String(value).padStart(2, '0');
}

function toLocalDateInput(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toLocalDateTimeInput(date) {
  return `${toLocalDateInput(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfLocalWeek(date = new Date()) {
  const result = startOfLocalDay(date);
  const mondayOffset = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - mondayOffset);
  return result;
}

function getRange(mode, anchor = new Date()) {
  const start = mode === 'week' ? startOfLocalWeek(anchor) : startOfLocalDay(anchor);
  const end = new Date(start);
  end.setDate(end.getDate() + (mode === 'week' ? 7 : 1));
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

function shiftCalendarDate(anchor, mode, direction) {
  const result = startOfLocalDay(anchor);
  result.setDate(result.getDate() + direction * (mode === 'week' ? 7 : 1));
  return result;
}

function eventStart(event) {
  return new Date(event.start?.dateTime || `${event.start?.date}T00:00:00`);
}

function eventEnd(event) {
  return new Date(event.end?.dateTime || `${event.end?.date}T00:00:00`);
}

function archivedEventsInRange(entries, start, end) {
  const firstDay = toLocalDateInput(start);
  const lastDay = toLocalDateInput(end);
  return entries.filter((entry) => {
    if (entry.start?.date) return entry.start.date >= firstDay && entry.start.date < lastDay;
    if (!entry.start?.dateTime) return false;
    const eventStart = new Date(entry.start.dateTime);
    return !Number.isNaN(eventStart.getTime()) && eventStart >= start && eventStart < end;
  });
}

function clampEndDateTime(startValue, endValue) {
  if (!startValue) return endValue;
  const start = new Date(startValue);
  if (Number.isNaN(start.getTime())) return endValue;
  const minimumEnd = new Date(start.getTime() + 15 * 60 * 1000);
  const end = new Date(endValue);
  return endValue && !Number.isNaN(end.getTime()) && end >= minimumEnd
    ? endValue
    : toLocalDateTimeInput(minimumEnd);
}

function buildEventResource(input) {
  const resource = {
    summary: String(input.summary || '').trim(),
    description: String(input.description || '').trim(),
    location: String(input.location || '').trim()
  };

  if (!resource.summary) throw new Error('Введите название события');

  if (input.attendees !== undefined) {
    resource.attendees = contactsForCalendar.normalizeGuestEmails(input.attendees).map((email) => ({ email }));
  }

  if (input.allDay) {
    if (!input.startDate) throw new Error('Укажите дату события');
    const endDate = input.endDate || input.startDate;
    if (endDate < input.startDate) throw new Error('Дата окончания не может быть раньше начала');
    const exclusiveEnd = new Date(`${endDate}T00:00:00`);
    exclusiveEnd.setDate(exclusiveEnd.getDate() + 1);
    resource.start = { date: input.startDate };
    resource.end = { date: toLocalDateInput(exclusiveEnd) };
  } else {
    const start = new Date(input.startDateTime);
    const end = new Date(input.endDateTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error('Укажите время начала и окончания');
    }
    if (end <= start) throw new Error('Окончание должно быть позже начала');
    resource.start = { dateTime: start.toISOString(), timeZone: input.timeZone };
    resource.end = { dateTime: end.toISOString(), timeZone: input.timeZone };
  }

  return resource;
}

function buildRescheduleResource(event, date, time) {
  const parsedDay = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : new Date(NaN);
  if (Number.isNaN(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== date) {
    throw new Error('Укажите корректную дату');
  }

  if (event.start?.date && event.end?.date) {
    const oldStart = new Date(`${event.start.date}T00:00:00Z`);
    const oldEnd = new Date(`${event.end.date}T00:00:00Z`);
    const days = (oldEnd - oldStart) / 86400000;
    if (!Number.isInteger(days) || days < 1) throw new Error('Не удалось определить длительность события');
    return {
      start: { date },
      end: { date: new Date(parsedDay.getTime() + days * 86400000).toISOString().slice(0, 10) }
    };
  }

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Укажите корректное время');
  const oldStart = new Date(event.start?.dateTime);
  const oldEnd = new Date(event.end?.dateTime);
  const duration = oldEnd - oldStart;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Не удалось определить длительность события');
  const newStart = new Date(`${date}T${time}`);
  if (Number.isNaN(newStart.getTime())) throw new Error('Укажите корректные дату и время');
  const newEnd = new Date(newStart.getTime() + duration);
  const start = { dateTime: newStart.toISOString() };
  const end = { dateTime: newEnd.toISOString() };
  if (event.start.timeZone) start.timeZone = event.start.timeZone;
  if (event.end.timeZone || event.start.timeZone) end.timeZone = event.end.timeZone || event.start.timeZone;
  return { start, end };
}

const calendarUtils = {
  archivedEventsInRange,
  buildEventResource,
  buildRescheduleResource,
  clampEndDateTime,
  eventEnd,
  eventStart,
  getRange,
  shiftCalendarDate,
  startOfLocalDay,
  startOfLocalWeek,
  toLocalDateInput,
  toLocalDateTimeInput
};

if (typeof module !== 'undefined' && module.exports) module.exports = calendarUtils;
else window.CalendarUtils = calendarUtils;
