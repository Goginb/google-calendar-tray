'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GoogleCalendarService } = require('../src/services/google-calendar');

function serviceWithApi(accessRole, calls) {
  const service = Object.create(GoogleCalendarService.prototype);
  service.getCalendarApi = () => ({
    calendarList: { get: async ({ calendarId }) => {
      calls.push(['access', calendarId]);
      return { data: { accessRole } };
    } },
    events: {
      insert: async (args) => { calls.push(['insert', args]); return { data: { id: 'new' } }; },
      patch: async (args) => { calls.push(['patch', args]); return { data: { id: args.eventId } }; },
      delete: async (args) => { calls.push(['delete', args]); }
    }
  });
  return service;
}

test('создание и удаление используют выбранный календарь и событие', async () => {
  const calls = [];
  const service = serviceWithApi('writer', calls);
  const resource = { summary: 'Встреча' };
  assert.deepEqual(await service.createEvent({ calendarId: 'team', resource }), { id: 'new', calendarId: 'team' });
  assert.deepEqual(await service.updateEvent({ calendarId: 'team', eventId: 'event-42', resource }), { id: 'event-42', calendarId: 'team' });
  assert.deepEqual(await service.deleteEvent({ calendarId: 'team', eventId: 'event-42' }), { deleted: true });
  assert.deepEqual(calls, [
    ['access', 'team'], ['insert', { calendarId: 'team', requestBody: resource, sendUpdates: 'all' }],
    ['access', 'team'], ['patch', { calendarId: 'team', eventId: 'event-42', requestBody: resource, sendUpdates: 'all' }],
    ['access', 'team'], ['delete', { calendarId: 'team', eventId: 'event-42' }]
  ]);
});

test('календари только для чтения не позволяют менять события', async () => {
  const calls = [];
  const service = serviceWithApi('reader', calls);
  await assert.rejects(service.createEvent({ calendarId: 'readonly', resource: { summary: 'Встреча' } }), /только для чтения/);
  await assert.rejects(service.updateEvent({ calendarId: 'readonly', eventId: 'event-42', resource: { summary: 'Новое' } }), /только для чтения/);
  await assert.rejects(service.deleteEvent({ calendarId: 'readonly', eventId: 'event-42' }), /только для чтения/);
  assert.deepEqual(calls, [['access', 'readonly'], ['access', 'readonly'], ['access', 'readonly']]);
});

test('обновление календаря читает все страницы событий и сохраняет принадлежность календарю', async () => {
  const calls = [];
  const service = Object.create(GoogleCalendarService.prototype);
  service.getCalendarApi = () => ({ events: { list: async (args) => {
    calls.push(args);
    return { data: args.pageToken
      ? { items: [{ id: 'second', start: { dateTime: '2026-10-03T12:00:00Z' } }] }
      : { items: [{ id: 'first', start: { dateTime: '2026-10-03T09:00:00Z' } }], nextPageToken: 'next' } };
  } } });
  const range = { calendarIds: ['team'], timeMin: '2026-10-03T00:00:00Z', timeMax: '2026-10-04T00:00:00Z' };
  const events = await service.listEvents(range);
  assert.deepEqual(events.map((event) => [event.id, event.calendarId]), [['first', 'team'], ['second', 'team']]);
  assert.equal(calls[1].pageToken, 'next');
  assert.equal(calls[1].timeMin, range.timeMin);
  assert.equal(calls[1].singleEvents, true);
});
