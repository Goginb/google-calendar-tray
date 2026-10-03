'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrayClickActions } = require('../src/lib/tray-clicks');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('одиночный клик открывает окно после ожидания второго клика', async () => {
  const calls = [];
  const actions = createTrayClickActions({ singleClick: () => calls.push('window'), doubleClick: () => calls.push('browser'), delayMs: 30 });
  try {
    actions.click();
    assert.deepEqual(calls, []);
    await wait(60);
    assert.deepEqual(calls, ['window']);
  } finally {
    actions.dispose();
  }
});

test('двойной клик открывает браузер без переключения окна приложения', async () => {
  const calls = [];
  const actions = createTrayClickActions({ singleClick: () => calls.push('window'), doubleClick: () => calls.push('browser'), delayMs: 30 });
  try {
    actions.click();
    actions.doubleClick();
    actions.click();
    await wait(60);
    assert.deepEqual(calls, ['browser']);
    actions.click();
    await wait(60);
    assert.deepEqual(calls, ['browser', 'window']);
  } finally {
    actions.dispose();
  }
});
