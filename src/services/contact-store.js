'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeContact, normalizeEmail, normalizeGuestEmails, guessNameFromEmail } = require('../lib/contact-utils');
const bundledContacts = require('../data/default-contacts.json');

const BUNDLED_CONTACTS_VERSION = 3;

class ContactStore {
  constructor(userDataPath, defaultContacts = bundledContacts) {
    this.filePath = path.join(userDataPath, 'contacts.json');
    const saved = this.read();
    this.contacts = saved.contacts;
    this.bundledContactsVersion = saved.bundledContactsVersion;
    if (this.bundledContactsVersion < BUNDLED_CONTACTS_VERSION) this.seedDefaults(defaultContacts);
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(parsed.contacts)) return { contacts: [], bundledContactsVersion: 0 };
      const contacts = parsed.contacts.flatMap((entry) => {
        try { return [normalizeContact(entry)]; } catch { return []; }
      });
      return { contacts, bundledContactsVersion: Number.isInteger(parsed.bundledContactsVersion) ? parsed.bundledContactsVersion : 0 };
    } catch { return { contacts: [], bundledContactsVersion: 0 }; }
  }

  seedDefaults(defaultContacts) {
    const addMissing = this.bundledContactsVersion === 0;
    for (const entry of defaultContacts) {
      const contact = normalizeContact(entry);
      const existing = this.contacts.find((item) => item.email === contact.email);
      if (existing) {
        if (!existing.name || (existing.email === 'greshtus@gmail.com' && ['Огибин Игорь', 'Агибин Игорь'].includes(existing.name))) {
          existing.name = contact.name;
        }
      } else if (addMissing) this.contacts.push(contact);
    }
    this.bundledContactsVersion = BUNDLED_CONTACTS_VERSION;
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ bundledContactsVersion: this.bundledContactsVersion, contacts: this.contacts }, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  list() {
    return [...this.contacts].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, 'ru'));
  }

  upsert(value) {
    const contact = normalizeContact(value);
    const existing = this.contacts.find((item) => item.email === contact.email);
    if (existing) existing.name = contact.name;
    else this.contacts.push(contact);
    this.save();
    return this.list();
  }

  remember(emails) {
    const normalized = normalizeGuestEmails(emails);
    let changed = false;
    for (const email of normalized) {
      if (!this.contacts.some((contact) => contact.email === email)) {
        this.contacts.push({ email, name: guessNameFromEmail(email) });
        changed = true;
      }
    }
    if (changed) this.save();
    return this.list();
  }

  remove(email) {
    const normalized = normalizeEmail(email);
    const index = this.contacts.findIndex((contact) => contact.email === normalized);
    if (index < 0) throw new Error('Контакт не найден');
    this.contacts.splice(index, 1);
    this.save();
    return this.list();
  }
}

module.exports = { ContactStore };
