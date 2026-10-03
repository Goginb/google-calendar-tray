'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ContactStore } = require('../src/services/contact-store');
const { guessNameFromEmail } = require('../src/lib/contact-utils');

test('контакты сохраняются между запусками, новые гости добавляются без дублей и сохраняют имена', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-tray-contacts-'));
  try {
    const store = new ContactStore(directory, []);
    store.upsert({ name: 'Коллега', email: ' Colleague@Example.com ' });
    store.remember(['colleague@example.com', 'NEW@example.com', 'new@example.com']);
    const reopened = new ContactStore(directory, []);
    assert.deepEqual(reopened.list(), [
      { name: 'Коллега', email: 'colleague@example.com' },
      { name: '', email: 'new@example.com' }
    ]);
    reopened.upsert({ name: 'Новый коллега', email: 'new@example.com' });
    assert.equal(new ContactStore(directory, []).list().find((contact) => contact.email === 'new@example.com').name, 'Новый коллега');
    reopened.remove('COLLEAGUE@example.com');
    assert.deepEqual(new ContactStore(directory, []).list().map((contact) => contact.email), ['new@example.com']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('неверные адреса не попадают в книгу', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-tray-contacts-'));
  try {
    const store = new ContactStore(directory, []);
    assert.throws(() => store.upsert({ name: 'Ошибка', email: 'missing-at-sign' }), /корректный адрес/);
    assert.throws(() => store.remember(['good@example.com', 'bad-address']), /Некорректный адрес/);
    assert.deepEqual(store.list(), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('имя из почты предлагается только при явном разделении слов', () => {
  assert.equal(guessNameFromEmail('jane.doe@example.com'), 'Jane Doe');
  assert.equal(guessNameFromEmail('ivan_petrov+team@example.com'), 'Ivan Petrov');
  assert.equal(guessNameFromEmail('greshtus@gmail.com'), '');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-tray-guessed-name-'));
  try {
    const store = new ContactStore(directory, []);
    store.remember(['jane.doe@example.com']);
    assert.equal(new ContactStore(directory, []).list()[0].name, 'Jane Doe');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('сотрудники из таблицы входят в программу и личные изменения сохраняются при обновлении', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-tray-bundled-'));
  try {
    const defaults = require('../src/data/default-contacts.json');
    assert.equal(defaults.length, 57);
    assert.equal(new Set(defaults.map((contact) => contact.email.toLowerCase())).size, 57);
    fs.writeFileSync(path.join(directory, 'contacts.json'), JSON.stringify({ contacts: [
      { name: 'Моё имя для Александра', email: 'kaygorodov.alex@gmail.com' },
      { name: 'Личный контакт', email: 'personal@example.com' }
    ] }));
    const store = new ContactStore(directory);
    assert.equal(store.list().length, 58);
    assert.equal(store.list().find((contact) => contact.email === 'kaygorodov.alex@gmail.com').name, 'Моё имя для Александра');
    assert.equal(store.list().find((contact) => contact.email === 'greshtus@gmail.com').email, 'greshtus@gmail.com');
    store.remove('greshtus@gmail.com');
    const reopened = new ContactStore(directory);
    assert.equal(reopened.list().length, 57);
    assert.equal(reopened.list().some((contact) => contact.email === 'greshtus@gmail.com'), false);
    assert.equal(reopened.list().some((contact) => contact.email === 'personal@example.com'), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('обновление исправляет имя Игоря и не возвращает удалённые контакты', () => {
  for (const [version, previousName] of [[1, 'Огибин Игорь'], [2, 'Агибин Игорь']]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-tray-contact-update-'));
    try {
      fs.writeFileSync(path.join(directory, 'contacts.json'), JSON.stringify({ bundledContactsVersion: version, contacts: [
        { name: previousName, email: 'greshtus@gmail.com' },
        { name: 'Моё имя', email: 'kaygorodov.alex@gmail.com' }
      ] }));
      const store = new ContactStore(directory);
      assert.equal(store.list().length, 2);
      assert.equal(store.list().find((contact) => contact.email === 'greshtus@gmail.com').name, 'Игорь Огибин');
      assert.equal(store.list().find((contact) => contact.email === 'kaygorodov.alex@gmail.com').name, 'Моё имя');
      assert.equal(new ContactStore(directory).list().length, 2);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
