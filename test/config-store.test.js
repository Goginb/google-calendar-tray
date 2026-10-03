'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore } = require('../src/services/config-store');

test('выбор нуля календарей сохраняется после перезапуска', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-tray-settings-'));
  try {
    const store = new ConfigStore(directory, {});
    store.setPublicSettings({ selectedCalendarIds: [], calendarSelectionInitialized: true });
    const reopened = new ConfigStore(directory, {});
    assert.deepEqual(reopened.getPublicSettings().selectedCalendarIds, []);
    assert.equal(reopened.getPublicSettings().calendarSelectionInitialized, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('старый сохранённый пустой выбор не сбрасывается на основной календарь', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-tray-legacy-'));
  try {
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ selectedCalendarIds: [], viewMode: 'today' }));
    const store = new ConfigStore(directory, {});
    assert.equal(store.getPublicSettings().calendarSelectionInitialized, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('режим показа выполненных по умолчанию выключен и сохраняется после перезапуска', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-tray-show-completed-'));
  try {
    const store = new ConfigStore(directory, {});
    assert.equal(store.getPublicSettings().showCompletedEvents, false);
    store.setPublicSettings({ showCompletedEvents: true });
    assert.equal(new ConfigStore(directory, {}).getPublicSettings().showCompletedEvents, true);
    store.setPublicSettings({ viewMode: 'week' });
    assert.equal(new ConfigStore(directory, {}).getPublicSettings().showCompletedEvents, true);
    store.setPublicSettings({ showCompletedEvents: false });
    assert.equal(new ConfigStore(directory, {}).getPublicSettings().showCompletedEvents, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
