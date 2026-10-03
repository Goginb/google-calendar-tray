'use strict';

const { GoogleCalendarService } = require('../../src/services/google-calendar');
const { CALENDAR_DESCRIPTION } = require('../../src/lib/completion-records');
const copy = (value) => JSON.parse(JSON.stringify(value));
const apiError = (code) => Object.assign(new Error(`Тестовая ошибка Google ${code}`), { code });

function createRemoteCalendar(accountId = 'team') {
  const remote = {
    calls: [], failRead: false, failWrite: false, pageSize: 2, tick: 0, beforeInsert: null,
    calendars: [
      { id: accountId, primary: true, accessRole: 'owner', summary: 'Личный календарь' },
      { id: 'readonly', accessRole: 'reader', summary: 'Общий календарь' }
    ],
    events: new Map()
  };
  const page = (items, token) => {
    const offset = Number(token || 0);
    return { data: { items: copy(items.slice(offset, offset + remote.pageSize)),
      ...(offset + remote.pageSize < items.length ? { nextPageToken: String(offset + remote.pageSize) } : {}) } };
  };
  const eventKey = (calendarId, eventId) => JSON.stringify([calendarId, eventId]);
  remote.addCalendar = (id) => {
    const calendar = { id, accessRole: 'owner', summary: 'Google Calendar Tray — Выполнено',
      description: `${CALENDAR_DESCRIPTION}\nAccount: ${accountId}` };
    remote.calendars.push(calendar);
    return calendar;
  };
  remote.put = (calendarId, eventId, resource) => {
    const event = { ...copy(resource), id: eventId, updated: new Date(Date.UTC(2026, 9, 3) + ++remote.tick * 1000).toISOString() };
    remote.events.set(eventKey(calendarId, eventId), event);
    return { data: copy(event) };
  };
  const api = {
    calendarList: {
      list: async (args) => {
        remote.calls.push(['calendarList', copy(args)]);
        if (remote.failRead) throw apiError(503);
        return page(remote.calendars.filter((calendar) => args.showHidden || !calendar.hidden), args.pageToken);
      },
      patch: async ({ calendarId, requestBody }) => {
        Object.assign(remote.calendars.find((calendar) => calendar.id === calendarId), requestBody);
        return { data: {} };
      }
    },
    calendars: { insert: async ({ requestBody }) => {
      if (remote.failWrite) throw apiError(503);
      const calendar = remote.addCalendar(`sync-${remote.calendars.length}`);
      Object.assign(calendar, requestBody);
      return { data: copy(calendar) };
    } },
    events: {
      list: async (args) => {
        remote.calls.push(['list', copy(args)]);
        if (remote.failRead) throw apiError(503);
        const entries = [...remote.events.entries()].filter(([key, value]) => JSON.parse(key)[0] === args.calendarId &&
          (args.privateExtendedProperty || []).every((filter) => {
            const [name, content] = filter.split('='); return value.extendedProperties?.private?.[name] === content;
          })).map(([, value]) => value);
        return page(entries, args.pageToken);
      },
      get: async ({ calendarId, eventId }) => {
        const event = remote.events.get(eventKey(calendarId, eventId));
        if (!event) throw apiError(404);
        return { data: copy(event) };
      },
      insert: async (args) => {
        remote.calls.push(['insert', copy(args)]);
        if (remote.failWrite) throw apiError(503);
        if (remote.beforeInsert) { const callback = remote.beforeInsert; remote.beforeInsert = null; await callback(args); }
        if (remote.events.has(eventKey(args.calendarId, args.requestBody.id))) throw apiError(409);
        return remote.put(args.calendarId, args.requestBody.id, args.requestBody);
      },
      patch: async (args) => {
        remote.calls.push(['patch', copy(args)]);
        if (remote.failWrite) throw apiError(503);
        const previous = remote.events.get(eventKey(args.calendarId, args.eventId));
        if (!previous) throw apiError(404);
        return remote.put(args.calendarId, args.eventId, { ...previous, ...args.requestBody });
      }
    }
  };
  remote.service = () => {
    const service = Object.create(GoogleCalendarService.prototype);
    service.getCalendarApi = () => api;
    return service;
  };
  return remote;
}

module.exports = { createRemoteCalendar };
