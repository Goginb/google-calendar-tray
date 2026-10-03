'use strict';

const HOUR_HEIGHT = 80;
const SNAP_MINUTES = 15;
const MINUTE_MS = 60000;

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / MINUTE_MS;
}

function dayOffset(from, to) {
  const stamp = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((stamp(to) - stamp(from)) / 86400000);
}

function snapMinute(minute) {
  return Math.round(minute / SNAP_MINUTES) * SNAP_MINUTES;
}

function shiftLocalTime(date, days, minutes) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  const wholeMinutes = Math.trunc(minutes);
  result.setMinutes(result.getMinutes() + wholeMinutes);
  return new Date(result.getTime() + Math.round((minutes - wholeMinutes) * MINUTE_MS));
}

function timedSegments(events, day) {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const segments = [];
  for (const event of events) {
    if (!event.start?.dateTime || !event.end?.dateTime || event.status === 'cancelled') continue;
    const eventStart = new Date(event.start.dateTime);
    const eventEnd = new Date(event.end.dateTime);
    if (!Number.isFinite(eventStart.getTime()) || !Number.isFinite(eventEnd.getTime()) || eventEnd <= eventStart || eventStart >= end || eventEnd <= start) continue;
    segments.push({
      event,
      startMinute: eventStart <= start ? 0 : minutesOfDay(eventStart),
      endMinute: eventEnd >= end ? 1440 : minutesOfDay(eventEnd),
      startsHere: eventStart >= start,
      endsHere: eventEnd <= end
    });
  }
  return segments;
}

function layoutSegments(segments) {
  const sorted = segments.map((segment) => ({ ...segment })).sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute);
  let group = [];
  let laneEnds = [];
  let groupEnd = -Infinity;
  function finishGroup() {
    for (const segment of group) segment.columns = laneEnds.length;
    group = []; laneEnds = []; groupEnd = -Infinity;
  }
  for (const segment of sorted) {
    if (segment.startMinute >= groupEnd) finishGroup();
    let column = laneEnds.findIndex((end) => end <= segment.startMinute);
    if (column < 0) column = laneEnds.length;
    laneEnds[column] = segment.endMinute;
    segment.column = column;
    group.push(segment);
    groupEnd = Math.max(groupEnd, segment.endMinute);
  }
  finishGroup();
  return sorted;
}

function buildTimelineResource(event, { kind, days = 0, minutes = 0 }) {
  if (!['move', 'resize'].includes(kind) || !Number.isInteger(days) || !Number.isFinite(minutes)) throw new Error('Некорректное изменение времени');
  if (!event.start?.dateTime || !event.end?.dateTime) throw new Error('Перетаскивание доступно для событий со временем');
  const oldStart = new Date(event.start.dateTime);
  const oldEnd = new Date(event.end.dateTime);
  const duration = oldEnd - oldStart;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Не удалось определить длительность события');
  let start = new Date(oldStart);
  let end = new Date(oldEnd);
  if (days || minutes) {
    if (kind === 'move') {
      start = shiftLocalTime(start, days, minutes);
      end = new Date(start.getTime() + duration);
    } else {
      end = shiftLocalTime(end, days, minutes);
      end = new Date(Math.max(end.getTime(), start.getTime() + SNAP_MINUTES * MINUTE_MS));
    }
  }
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new Error('Укажите корректное время');
  return {
    start: { dateTime: start.toISOString(), ...(event.start.timeZone ? { timeZone: event.start.timeZone } : {}) },
    end: { dateTime: end.toISOString(), ...(event.end.timeZone || event.start.timeZone ? { timeZone: event.end.timeZone || event.start.timeZone } : {}) }
  };
}

const timelineUtils = { HOUR_HEIGHT, SNAP_MINUTES, minutesOfDay, dayOffset, snapMinute, timedSegments, layoutSegments, buildTimelineResource };
if (typeof module !== 'undefined' && module.exports) module.exports = timelineUtils;
else window.TimelineUtils = timelineUtils;
