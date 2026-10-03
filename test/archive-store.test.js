'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ArchiveStore } = require('../src/services/archive-store');

test('архив сохраняет запись за пределами текущего периода и отделяет аккаунты', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-tray-archive-'));
  try {
    const store = new ArchiveStore(directory);
    const event = { id: 'event-1', calendarId: 'team', summary: 'Старая задача', start: { date: '2025-01-01' } };
    assert.equal(store.archive('first@example.com', event).length, 1);
    assert.equal(store.archive('first@example.com', event).length, 1);
    assert.deepEqual(store.list('second@example.com'), []);
    const reopened = new ArchiveStore(directory);
    assert.equal(reopened.list('first@example.com')[0].summary, 'Старая задача');
    assert.equal(reopened.list('first@example.com')[0].start.date, '2025-01-01');
    assert.deepEqual(reopened.restore('first@example.com', 'team', 'event-1'), []);
    assert.deepEqual(new ArchiveStore(directory).list('first@example.com'), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('одинаковый ID в разных календарях архивируется отдельно', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-tray-archive-'));
  try {
    const store = new ArchiveStore(directory);
    store.archive('account', { id: 'same', calendarId: 'one', start: { date: '2026-09-24' } });
    store.archive('account', { id: 'same', calendarId: 'two', start: { date: '2026-09-24' } });
    assert.equal(store.list('account').length, 2);
    store.restore('account', 'one', 'same');
    assert.equal(store.list('account')[0].calendarId, 'two');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
