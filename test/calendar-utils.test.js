'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { archivedEventsInRange, buildEventResource, buildRescheduleResource, clampEndDateTime, shiftCalendarDate, startOfLocalWeek } = require('../src/lib/calendar-utils');

test('неделя начинается в понедельник', () => {
  const result = startOfLocalWeek(new Date(2026, 7, 28, 16, 30));
  assert.equal(result.getDay(), 1);
  assert.equal(result.getDate(), 24);
  assert.equal(result.getHours(), 0);
});

test('стрелки перелистывают день или неделю через границу месяца', () => {
  const anchor = new Date(2026, 8, 30, 15, 20);
  const nextDay = shiftCalendarDate(anchor, 'today', 1);
  const previousWeek = shiftCalendarDate(anchor, 'week', -1);
  assert.equal(nextDay.getMonth(), 9);
  assert.equal(nextDay.getDate(), 1);
  assert.equal(nextDay.getHours(), 0);
  assert.equal(previousWeek.getDate(), 23);
  assert.equal(previousWeek.getMonth(), 8);
});

test('событие на весь день получает исключительную дату окончания', () => {
  const resource = buildEventResource({ summary: 'Отпуск', allDay: true, startDate: '2026-08-28', endDate: '2026-08-30' });
  assert.deepEqual(resource.start, { date: '2026-08-28' });
  assert.deepEqual(resource.end, { date: '2026-08-31' });
});

test('обычное событие проверяет порядок времени', () => {
  assert.throws(() => buildEventResource({
    summary: 'Ошибка',
    allDay: false,
    startDateTime: '2026-08-28T12:00',
    endDateTime: '2026-08-28T11:00',
    timeZone: 'Europe/Moscow'
  }), /позже начала/);
});

test('событие на весь день проверяет порядок дат', () => {
  assert.throws(() => buildEventResource({
    summary: 'Ошибка',
    allDay: true,
    startDate: '2026-08-30',
    endDate: '2026-08-28'
  }), /раньше начала/);
});

test('пустое название запрещено', () => {
  assert.throws(() => buildEventResource({ summary: '  ', allDay: true, startDate: '2026-08-28' }), /название/);
});

test('гости передаются в событие по почте без повторов и с проверкой адресов', () => {
  const input = { summary: 'Встреча', allDay: true, startDate: '2026-09-30', attendees: ['A@Example.com', 'a@example.com', 'b@example.com'] };
  assert.deepEqual(buildEventResource(input).attendees, [{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  assert.throws(() => buildEventResource({ ...input, attendees: ['bad-address'] }), /Некорректный адрес/);
});

test('выполненные события отбираются по дате события, а не по дате отметки', () => {
  const entries = [
    { eventId: 'previous', start: { date: '2026-09-28' }, archivedAt: '2026-09-29T12:00:00Z' },
    { eventId: 'selected', start: { date: '2026-09-29' }, archivedAt: '2026-09-01T12:00:00Z' },
    { eventId: 'timed', start: { dateTime: '2026-09-29T15:30:00+03:00' } },
    { eventId: 'next', start: { date: '2026-09-30' } },
    { eventId: 'unknown', start: {} }
  ];
  const start = new Date(2026, 8, 29);
  const end = new Date(2026, 8, 30);
  assert.deepEqual(archivedEventsInRange(entries, start, end).map((entry) => entry.eventId), ['selected', 'timed']);
});

test('окончание сдвигается минимум на 15 минут и переносится на следующий день', () => {
  assert.equal(clampEndDateTime('2026-09-29T23:55', '2026-09-29T23:55'), '2026-09-30T00:10');
  assert.equal(clampEndDateTime('2026-09-29T23:55', '2026-09-30T00:05'), '2026-09-30T00:10');
  assert.equal(clampEndDateTime('2026-09-29T23:55', '2026-09-30T00:45'), '2026-09-30T00:45');
});

test('перенос встречи сохраняет длительность, часовой пояс и остальные поля события', () => {
  const event = {
    summary: 'Встреча',
    attendees: [{ email: 'colleague@example.com' }],
    start: { dateTime: '2026-09-29T23:30:00+03:00', timeZone: 'Europe/Moscow' },
    end: { dateTime: '2026-09-30T01:00:00+03:00', timeZone: 'Europe/Moscow' }
  };
  const resource = buildRescheduleResource(event, '2026-10-02', '22:15');
  assert.equal(new Date(resource.end.dateTime) - new Date(resource.start.dateTime), 90 * 60000);
  assert.equal(resource.start.timeZone, 'Europe/Moscow');
  assert.equal(resource.end.timeZone, 'Europe/Moscow');
  assert.deepEqual(Object.keys(resource), ['start', 'end']);
  assert.equal(event.summary, 'Встреча');
});

test('перенос многодневного события сохраняет число дней через смену месяца', () => {
  const event = { start: { date: '2026-09-29' }, end: { date: '2026-10-02' } };
  assert.deepEqual(buildRescheduleResource(event, '2026-10-30', ''), {
    start: { date: '2026-10-30' }, end: { date: '2026-11-02' }
  });
});

test('перенос отклоняет некорректную дату, время и исходную длительность', () => {
  const event = { start: { dateTime: '2026-09-29T10:00:00Z' }, end: { dateTime: '2026-09-29T11:00:00Z' } };
  assert.throws(() => buildRescheduleResource(event, '2026-02-30', '12:00'), /дату/);
  assert.throws(() => buildRescheduleResource(event, '2026-10-02', '25:00'), /время/);
  assert.throws(() => buildRescheduleResource({ ...event, end: event.start }, '2026-10-02', '12:00'), /длительность/);
});
