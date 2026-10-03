'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ArchiveStore } = require('../src/services/archive-store');
const { CompletionSync } = require('../src/services/completion-sync');
const { recordId, recordResource } = require('../src/lib/completion-records');
const { createRemoteCalendar } = require('./helpers/completion-api');

function device(t, remote) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-sync-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ArchiveStore(directory);
  return { store, directory, sync: new CompletionSync(remote.service(), store) };
}
const task = (id = 'task', calendarId = 'readonly') => ({
  id, calendarId, summary: 'Тестовая задача', location: 'Офис',
  start: { dateTime: '2026-10-03T09:00:00+03:00' }, calendarSummary: 'Команда', calendarColor: '#ff0000'
});

test('два устройства синхронизируют выполнение и возврат, в том числе календарь только для чтения', async (t) => {
  const remote = createRemoteCalendar();
  const first = device(t, remote); const second = device(t, remote);
  assert.deepEqual(await first.sync.list('team'), []);
  assert.equal(remote.calendars.length, 2, 'Пустой архив не создаёт календарь');
  await first.sync.archive('team', task());
  const completed = await second.sync.list('team');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].calendarId, 'readonly');
  assert.equal(completed[0].summary, 'Тестовая задача');
  await second.sync.restore('team', 'readonly', 'task');
  assert.deepEqual(await first.sync.list('team'), []);
  assert.deepEqual(new ArchiveStore(first.directory).list('team'), []);
  const writes = remote.calls.filter(([kind]) => ['insert', 'patch'].includes(kind));
  assert.ok(writes.every(([, args]) => args.calendarId.startsWith('sync-') && args.sendUpdates === 'none' && !args.requestBody.attendees));
  assert.ok(remote.calendars.find((calendar) => calendar.id.startsWith('sync-')).hidden);
  assert.equal((await remote.service().listCalendars()).length, 2, 'Служебный календарь скрыт из списка приложения');
});

test('старый архив переносится один раз; позднее подключившееся устройство не возвращает снятую отметку', async (t) => {
  const remote = createRemoteCalendar();
  const first = device(t, remote); const older = device(t, remote);
  first.store.archive('team', task()); older.store.archive('team', task());
  assert.equal((await first.sync.list('team')).length, 1);
  await first.sync.restore('team', 'readonly', 'task');
  assert.deepEqual(await older.sync.list('team'), []);
  assert.deepEqual(older.store.pendingMigration('team'), []);
  const reopened = new CompletionSync(remote.service(), new ArchiveStore(older.directory));
  assert.deepEqual(await reopened.list('team'), []);
  assert.equal([...remote.events.values()].length, 1, 'Нет дубликатов при переносе');
});

test('сбой сети сохраняет локальную копию и незавершённый перенос для следующей попытки', async (t) => {
  const remote = createRemoteCalendar(); const first = device(t, remote);
  first.store.archive('team', task());
  remote.failWrite = true;
  await assert.rejects(first.sync.list('team'), /503/);
  assert.equal(first.store.pendingMigration('team').length, 1);
  assert.equal(first.store.list('team').length, 1);
  remote.failWrite = false;
  await first.sync.list('team');
  remote.failWrite = true;
  await assert.rejects(first.sync.restore('team', 'readonly', 'task'), /503/);
  assert.equal(first.store.list('team').length, 1);
  remote.failWrite = false; remote.failRead = true;
  await assert.rejects(first.sync.list('team'), /503/);
  assert.equal(first.store.list('team').length, 1);
  remote.failRead = false;
  assert.deepEqual(await first.sync.restore('team', 'readonly', 'task'), []);
});

test('все страницы и отдельные экземпляры повторений синхронизируются без смешения календарей', async (t) => {
  const remote = createRemoteCalendar(); const first = device(t, remote); const second = device(t, remote);
  const tasks = [task('same', 'team'), task('same', 'readonly'), task('series_20261003'), task('series_20261004'), task('all-day')];
  tasks[4].start = { date: '2026-10-03' };
  for (const event of tasks) await first.sync.archive('team', event);
  assert.equal((await second.sync.list('team')).length, 5);
  await second.sync.restore('team', 'readonly', 'series_20261003');
  await second.sync.restore('team', 'team', 'same');
  const remaining = await first.sync.list('team');
  assert.equal(remaining.length, 3);
  assert.ok(remaining.some((entry) => entry.calendarId === 'readonly' && entry.eventId === 'same'));
  assert.ok(remaining.some((entry) => entry.eventId === 'all-day' && entry.start.date === '2026-10-03'));
});

test('конфликт при переносе сохраняет отметку возврата, записанную другим устройством', async (t) => {
  const remote = createRemoteCalendar(); const first = device(t, remote);
  first.store.archive('team', task());
  remote.beforeInsert = (args) => remote.put(args.calendarId, args.requestBody.id, recordResource(task(), false));
  assert.deepEqual(await first.sync.list('team'), []);
  assert.deepEqual(first.store.pendingMigration('team'), []);
});

test('одновременное создание служебных календарей объединяется; миграция уступает явному действию', async (t) => {
  const remote = createRemoteCalendar(); const first = device(t, remote);
  remote.addCalendar('sync-one'); remote.addCalendar('sync-two');
  remote.put('sync-one', recordId(task()), recordResource(task(), false));
  remote.put('sync-two', recordId(task()), recordResource(task(), true, 'legacy'));
  assert.deepEqual(await first.sync.list('team'), []);
  await first.sync.archive('team', task());
  assert.equal((await first.sync.list('team')).length, 1);
  remote.put('sync-two', recordId(task()), recordResource(task(), false));
  assert.deepEqual(await first.sync.list('team'), []);
});

test('чужой аккаунт не получает отметки; некорректное событие не создаёт служебный календарь', async (t) => {
  const remote = createRemoteCalendar(); const first = device(t, remote);
  first.store.archive('another-account', task());
  await assert.rejects(first.sync.archive('another-account', task()), /другому Google-аккаунту/);
  await assert.rejects(first.sync.archive('team', { calendarId: 'team' }), /Не выбрано событие/);
  assert.equal(remote.calendars.length, 2);
  assert.equal(first.store.list('another-account').length, 1);
  assert.equal(remote.events.size, 0);
});

test('первое одновременное выполнение на двух устройствах сохраняет обе задачи', async (t) => {
  const remote = createRemoteCalendar(); const first = device(t, remote); const second = device(t, remote);
  await Promise.all([first.sync.archive('team', task('first')), second.sync.archive('team', task('second'))]);
  const firstResult = await first.sync.list('team');
  const secondResult = await second.sync.list('team');
  assert.deepEqual(firstResult.map((entry) => entry.eventId).sort(), ['first', 'second']);
  assert.deepEqual(secondResult, firstResult);
  await second.sync.restore('team', 'readonly', 'first');
  assert.deepEqual((await first.sync.list('team')).map((entry) => entry.eventId), ['second']);
});
