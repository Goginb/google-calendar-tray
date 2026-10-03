'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { entryKey } = require('../lib/completion-records');

class ArchiveStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'archive.json');
    this.data = this.read();
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && parsed.accounts && typeof parsed.accounts === 'object' && !Array.isArray(parsed.accounts)
        ? parsed : { accounts: {} };
    } catch {
      return { accounts: {} };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  accountEntries(accountId) {
    if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('Не удалось определить Google-аккаунт');
    const key = Buffer.from(accountId, 'utf8').toString('base64url');
    if (!Array.isArray(this.data.accounts[key])) this.data.accounts[key] = [];
    return this.data.accounts[key];
  }

  list(accountId) {
    return [...this.accountEntries(accountId)].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }

  pendingMigration(accountId) {
    const entries = this.accountEntries(accountId);
    const key = Buffer.from(accountId, 'utf8').toString('base64url');
    if (!this.data.migrations || typeof this.data.migrations !== 'object' || Array.isArray(this.data.migrations)) this.data.migrations = {};
    if (!Array.isArray(this.data.migrations[key])) {
      // Freeze the old local archive once; later cloud cache entries aren't migration candidates.
      this.data.migrations[key] = [...entries];
      this.save();
    }
    return [...this.data.migrations[key]];
  }

  applyCloud(accountId, completedEntries, knownKeys) {
    const known = new Set(knownKeys);
    const pending = this.pendingMigration(accountId).filter((entry) => !known.has(entryKey(entry)));
    const key = Buffer.from(accountId, 'utf8').toString('base64url');
    this.data.migrations[key] = pending;
    const entries = [...completedEntries, ...pending].map(({ completed, origin, updated, recordCalendarId, ...entry }) => entry);
    this.data.accounts[key] = entries;
    this.save();
    return this.list(accountId);
  }

  archive(accountId, event) {
    if (!event || typeof event.calendarId !== 'string' || !event.calendarId || typeof event.id !== 'string' || !event.id) {
      throw new Error('Не выбрано событие для архива');
    }
    const entries = this.accountEntries(accountId);
    if (entries.some((entry) => entry.calendarId === event.calendarId && entry.eventId === event.id)) return this.list(accountId);
    entries.push({
      calendarId: event.calendarId,
      eventId: event.id,
      summary: String(event.summary || '(Без названия)').slice(0, 1024),
      location: String(event.location || '').slice(0, 1024),
      start: { date: event.start?.date || null, dateTime: event.start?.dateTime || null },
      calendarSummary: String(event.calendarSummary || event.calendarId).slice(0, 1024),
      calendarColor: String(event.calendarColor || '#4285f4'),
      archivedAt: new Date().toISOString()
    });
    this.save();
    return this.list(accountId);
  }

  restore(accountId, calendarId, eventId) {
    const entries = this.accountEntries(accountId);
    const index = entries.findIndex((entry) => entry.calendarId === calendarId && entry.eventId === eventId);
    if (index < 0) throw new Error('Событие не найдено в архиве');
    entries.splice(index, 1);
    this.save();
    return this.list(accountId);
  }
}

module.exports = { ArchiveStore };
