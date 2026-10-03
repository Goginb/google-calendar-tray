'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calendarApp', {
  getInitialState: () => ipcRenderer.invoke('app:get-initial-state'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  importCredentials: () => ipcRenderer.invoke('auth:import-credentials'),
  signIn: () => ipcRenderer.invoke('auth:sign-in'),
  signOut: () => ipcRenderer.invoke('auth:sign-out'),
  listCalendars: () => ipcRenderer.invoke('calendar:list'),
  listEvents: (args) => ipcRenderer.invoke('events:list', args),
  createEvent: (args) => ipcRenderer.invoke('events:create', args),
  updateEvent: (args) => ipcRenderer.invoke('events:update', args),
  deleteEvent: (args) => ipcRenderer.invoke('events:delete', args),
  listArchive: (accountId) => ipcRenderer.invoke('archive:list', accountId),
  listCachedArchive: (accountId) => ipcRenderer.invoke('archive:cached', accountId),
  archiveEvent: (accountId, event) => ipcRenderer.invoke('archive:add', accountId, event),
  restoreArchivedEvent: (accountId, calendarId, eventId) => ipcRenderer.invoke('archive:restore', accountId, calendarId, eventId),
  listContacts: () => ipcRenderer.invoke('contacts:list'),
  saveContact: (contact) => ipcRenderer.invoke('contacts:save', contact),
  rememberContacts: (emails) => ipcRenderer.invoke('contacts:remember', emails),
  removeContact: (email) => ipcRenderer.invoke('contacts:remove', email),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  hideWindow: () => ipcRenderer.send('window:hide'),
  onNavigate: (callback) => ipcRenderer.on('navigate', (_event, page) => callback(page)),
  onSyncRefresh: (callback) => ipcRenderer.on('sync-refresh', () => callback())
});
