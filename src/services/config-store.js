'use strict';

const fs = require('node:fs');
const path = require('node:path');

class ConfigStore {
  constructor(userDataPath, safeStorage) {
    this.filePath = path.join(userDataPath, 'settings.json');
    this.safeStorage = safeStorage;
    this.data = this.read();
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return { selectedCalendarIds: [], calendarSelectionInitialized: false, viewMode: 'today' };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  getPublicSettings() {
    return {
      selectedCalendarIds: Array.isArray(this.data.selectedCalendarIds) ? this.data.selectedCalendarIds : [],
      calendarSelectionInitialized: this.data.calendarSelectionInitialized === true ||
        (this.data.calendarSelectionInitialized === undefined && Array.isArray(this.data.selectedCalendarIds)),
      viewMode: this.data.viewMode === 'week' ? 'week' : 'today',
      showCompletedEvents: this.data.showCompletedEvents === true
    };
  }

  setPublicSettings(next) {
    if (Array.isArray(next.selectedCalendarIds)) this.data.selectedCalendarIds = next.selectedCalendarIds;
    if (typeof next.calendarSelectionInitialized === 'boolean') this.data.calendarSelectionInitialized = next.calendarSelectionInitialized;
    if (['today', 'week'].includes(next.viewMode)) this.data.viewMode = next.viewMode;
    if (typeof next.showCompletedEvents === 'boolean') this.data.showCompletedEvents = next.showCompletedEvents;
    this.save();
    return this.getPublicSettings();
  }

  setTokens(tokens) {
    const raw = JSON.stringify(tokens);
    if (this.safeStorage.isEncryptionAvailable()) {
      this.data.encryptedTokens = this.safeStorage.encryptString(raw).toString('base64');
      delete this.data.plainTokens;
    } else {
      this.data.plainTokens = raw;
      delete this.data.encryptedTokens;
    }
    this.save();
  }

  getTokens() {
    try {
      if (this.data.encryptedTokens && this.safeStorage.isEncryptionAvailable()) {
        const buffer = Buffer.from(this.data.encryptedTokens, 'base64');
        return JSON.parse(this.safeStorage.decryptString(buffer));
      }
      return this.data.plainTokens ? JSON.parse(this.data.plainTokens) : null;
    } catch {
      return null;
    }
  }

  clearTokens() {
    delete this.data.encryptedTokens;
    delete this.data.plainTokens;
    this.save();
  }
}

module.exports = { ConfigStore };
