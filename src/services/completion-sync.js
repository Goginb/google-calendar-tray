'use strict';

const { CALENDAR_DESCRIPTION, RECORD_TYPE, entryKey, recordId, recordResource, parseRecord, mergeRecord } = require('../lib/completion-records');

function statusCode(error) {
  return Number(error.response?.status || error.code);
}

class CompletionSync {
  constructor(calendarService, archiveStore) {
    this.calendarService = calendarService;
    this.archiveStore = archiveStore;
    this.queue = Promise.resolve();
  }

  run(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async context(accountId, create = false) {
    const api = this.calendarService.getCalendarApi();
    const calendars = await this.calendarService.listCalendarEntries({ showHidden: true });
    if (!accountId || calendars.find((calendar) => calendar.primary)?.id !== accountId) {
      throw new Error('Архив принадлежит другому Google-аккаунту. Обновите список календарей.');
    }
    const description = `${CALENDAR_DESCRIPTION}\nAccount: ${accountId}`;
    const syncCalendars = calendars.filter((calendar) => calendar.accessRole === 'owner' && calendar.description === description)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!syncCalendars.length && create) {
      const response = await api.calendars.insert({ requestBody: {
        summary: 'Google Calendar Tray — Выполнено', description, timeZone: 'UTC'
      } });
      syncCalendars.push(response.data);
      // Hiding is cosmetic: a failed calendar-list update must not lose a saved task.
      await api.calendarList.patch({ calendarId: response.data.id, requestBody: { selected: false, hidden: true } }).catch(() => {});
    }
    return { api, syncCalendars };
  }

  async readRecords(context) {
    const records = new Map();
    for (const calendar of context.syncCalendars) {
      let pageToken;
      do {
        const response = await context.api.events.list({
          calendarId: calendar.id, maxResults: 2500,
          privateExtendedProperty: [`${RECORD_TYPE}=1`], ...(pageToken ? { pageToken } : {})
        });
        for (const event of response.data.items || []) mergeRecord(records, parseRecord(event, calendar.id));
        pageToken = response.data.nextPageToken;
      } while (pageToken);
    }
    return records;
  }

  saveCache(accountId, records) {
    return this.archiveStore.applyCloud(accountId, [...records.values()].filter((record) => record.completed), [...records.keys()]);
  }

  async migrate(accountId, context, records) {
    for (const entry of this.archiveStore.pendingMigration(accountId)) {
      if (records.has(entryKey(entry))) continue;
      const calendarId = context.syncCalendars[0]?.id;
      if (!calendarId) throw new Error('Не удалось создать календарь синхронизации');
      const record = await this.writeRecord(context.api, calendarId, entry, true, 'legacy');
      mergeRecord(records, record);
      // Persist each confirmed import so interruption resumes without overwriting remote changes.
      this.saveCache(accountId, records);
    }
    return this.saveCache(accountId, records);
  }

  async writeRecord(api, calendarId, entry, completed, origin = 'user') {
    const eventId = recordId(entry);
    const requestBody = recordResource(entry, completed, origin);
    const args = { calendarId, eventId, requestBody, sendUpdates: 'none' };
    let response;
    if (origin !== 'legacy') {
      try {
        response = await api.events.patch(args);
      } catch (error) {
        if (statusCode(error) !== 404) throw error;
      }
    }
    if (!response) {
      try {
        response = await api.events.insert({ calendarId, requestBody: { id: eventId, ...requestBody }, sendUpdates: 'none' });
      } catch (error) {
        if (statusCode(error) !== 409) throw error;
        // Migration only fills missing records. Explicit actions can update existing records.
        response = origin === 'legacy'
          ? await api.events.get({ calendarId, eventId })
          : await api.events.patch(args);
      }
    }
    const record = parseRecord(response.data, calendarId);
    if (!record) throw new Error('Google не подтвердил сохранение отметки. Обновите календарь.');
    return record;
  }

  list(accountId) {
    return this.run(async () => {
      const pending = this.archiveStore.pendingMigration(accountId);
      const context = await this.context(accountId, pending.length > 0);
      return this.migrate(accountId, context, await this.readRecords(context));
    });
  }

  archive(accountId, event) {
    return this.change(accountId, { ...event, eventId: event?.id }, true);
  }

  restore(accountId, calendarId, eventId) {
    return this.change(accountId, { calendarId, eventId }, false);
  }

  change(accountId, entry, completed) {
    return this.run(async () => {
      // Validate before any cloud write, including creating the service calendar.
      recordResource(entry, completed);
      const context = await this.context(accountId, true);
      const records = await this.readRecords(context);
      await this.migrate(accountId, context, records);
      const previous = records.get(entryKey(entry));
      const source = completed ? entry : { ...previous, ...entry };
      const record = await this.writeRecord(context.api, previous?.recordCalendarId || context.syncCalendars[0].id, source, completed);
      records.set(entryKey(record), record);
      return this.saveCache(accountId, records);
    });
  }
}

module.exports = { CompletionSync };
