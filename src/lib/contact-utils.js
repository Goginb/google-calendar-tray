'use strict';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  const email = normalizeEmail(value);
  return email.length <= 254 && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email);
}

function normalizeContact(value) {
  const email = normalizeEmail(value?.email);
  if (!validEmail(email)) throw new Error('Введите корректный адрес электронной почты');
  return { email, name: String(value?.name || '').trim().slice(0, 200) };
}

function guessNameFromEmail(value) {
  const email = normalizeEmail(value);
  if (!validEmail(email)) return '';
  const localPart = email.split('@')[0].split('+')[0];
  const parts = localPart.split(/[._-]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^[a-zа-яё]{2,}$/iu.test(part))) return '';
  return parts.map((part) => part[0].toLocaleUpperCase('ru') + part.slice(1)).join(' ');
}

function normalizeGuestEmails(values) {
  if (!Array.isArray(values)) throw new Error('Список гостей имеет неверный формат');
  const emails = [];
  const seen = new Set();
  for (const value of values) {
    const email = normalizeEmail(value);
    if (!validEmail(email)) throw new Error(`Некорректный адрес гостя: ${String(value || '').trim()}`);
    if (!seen.has(email)) { emails.push(email); seen.add(email); }
  }
  return emails;
}

const contactUtils = { normalizeEmail, validEmail, normalizeContact, normalizeGuestEmails, guessNameFromEmail };
if (typeof module !== 'undefined' && module.exports) module.exports = contactUtils;
else window.ContactUtils = contactUtils;
