'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { google } = require('googleapis');
const { isSyncCalendar } = require('../lib/completion-records');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

class GoogleCalendarService {
  constructor({ app, shell, store }) {
    this.app = app;
    this.shell = shell;
    this.store = store;
    this.oauth2 = null;
    this.authInProgress = null;
  }

  credentialCandidates() {
    return [
      process.env.GOOGLE_CALENDAR_CREDENTIALS,
      path.join(this.app.getPath('userData'), 'credentials.json'),
      path.join(process.cwd(), 'credentials.json')
    ].filter(Boolean);
  }

  getCredentialsPath() {
    return this.credentialCandidates().find((candidate) => fs.existsSync(candidate)) || null;
  }

  readCredentials() {
    const credentialsPath = this.getCredentialsPath();
    if (!credentialsPath) {
      throw new Error('Не найден credentials.json. Импортируйте OAuth-клиент в настройках.');
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    } catch {
      throw new Error('credentials.json повреждён или имеет неверный формат');
    }
    const credentials = parsed.installed;
    if (!credentials?.client_id || !credentials?.client_secret) {
      throw new Error('Нужен OAuth client типа Desktop app в credentials.json');
    }
    return credentials;
  }

  createClient(redirectUri = 'http://127.0.0.1') {
    const credentials = this.readCredentials();
    const client = new google.auth.OAuth2(credentials.client_id, credentials.client_secret, redirectUri);
    const tokens = this.store.getTokens();
    if (tokens) client.setCredentials(tokens);
    client.on('tokens', (freshTokens) => {
      const merged = { ...(this.store.getTokens() || {}), ...freshTokens };
      this.store.setTokens(merged);
    });
    this.oauth2 = client;
    return client;
  }

  async status() {
    const credentialsConfigured = Boolean(this.getCredentialsPath());
    const signedIn = credentialsConfigured && Boolean(this.store.getTokens()?.refresh_token || this.store.getTokens()?.access_token);
    return { credentialsConfigured, signedIn };
  }

  async importCredentials(sourcePath) {
    const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    const credentials = parsed.installed;
    if (!credentials?.client_id || !credentials?.client_secret) {
      throw new Error('Выберите JSON OAuth-клиента типа Desktop app');
    }
    const target = path.join(this.app.getPath('userData'), 'credentials.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(sourcePath, target);
    this.store.clearTokens();
    this.oauth2 = null;
    return this.status();
  }

  async signIn() {
    if (this.authInProgress) return this.authInProgress;
    this.authInProgress = this.performSignIn().finally(() => { this.authInProgress = null; });
    return this.authInProgress;
  }

  async performSignIn() {
    this.readCredentials();
    const state = crypto.randomBytes(24).toString('hex');

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        server.close();
        error ? reject(error) : resolve(value);
      };

      const server = http.createServer(async (request, response) => {
        try {
          const requestUrl = new URL(request.url, `http://${request.headers.host}`);
          if (requestUrl.pathname !== '/oauth2callback') {
            response.writeHead(404).end('Not found');
            return;
          }
          if (requestUrl.searchParams.get('state') !== state) throw new Error('Неверный OAuth state');
          const authError = requestUrl.searchParams.get('error');
          if (authError) throw new Error(`Авторизация отменена: ${authError}`);
          const code = requestUrl.searchParams.get('code');
          if (!code) throw new Error('Google не вернул код авторизации');

          const { tokens } = await this.oauth2.getToken(code);
          this.oauth2.setCredentials(tokens);
          this.store.setTokens(tokens);
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end('<!doctype html><meta charset="utf-8"><title>Готово</title><style>body{font:18px system-ui;margin:48px;color:#202124}</style><h2>Готово</h2><p>Google Calendar подключён. Это окно можно закрыть.</p>');
          finish(null, { signedIn: true });
        } catch (error) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end(error.message);
          finish(error);
        }
      });

      server.on('error', finish);
      server.listen(0, '127.0.0.1', async () => {
        try {
          const { port } = server.address();
          const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
          const client = this.createClient(redirectUri);
          const authUrl = client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: SCOPES,
            state
          });
          await this.shell.openExternal(authUrl);
        } catch (error) {
          finish(error);
        }
      });

      const timeout = setTimeout(() => finish(new Error('Время ожидания авторизации истекло')), 5 * 60 * 1000);
    });
  }

  signOut() {
    this.store.clearTokens();
    this.oauth2 = null;
    return { signedIn: false };
  }

  getCalendarApi() {
    const client = this.oauth2 || this.createClient();
    if (!this.store.getTokens()) throw new Error('Сначала подключите Google Calendar');
    return google.calendar({ version: 'v3', auth: client });
  }

  async listCalendarEntries({ showHidden = false } = {}) {
    const api = this.getCalendarApi();
    const entries = [];
    let pageToken;
    do {
      const result = await api.calendarList.list({ maxResults: 250, showHidden, ...(pageToken ? { pageToken } : {}) });
      entries.push(...(result.data.items || []));
      pageToken = result.data.nextPageToken;
    } while (pageToken);
    return entries;
  }

  async listCalendars() {
    return (await this.listCalendarEntries()).filter((calendar) => !isSyncCalendar(calendar)).map((calendar) => ({
      id: calendar.id,
      summary: calendar.summaryOverride || calendar.summary || calendar.id,
      primary: Boolean(calendar.primary),
      selected: calendar.selected !== false,
      accessRole: calendar.accessRole,
      backgroundColor: calendar.backgroundColor || '#4285f4',
      foregroundColor: calendar.foregroundColor || '#ffffff'
    }));
  }

  async listEvents({ calendarIds, timeMin, timeMax }) {
    const api = this.getCalendarApi();
    const results = await Promise.all(calendarIds.map(async (calendarId) => {
      const events = [];
      let pageToken;
      do {
        const response = await api.events.list({
          calendarId, timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 2500,
          ...(pageToken ? { pageToken } : {})
        });
        events.push(...(response.data.items || []).map((event) => ({ ...event, calendarId })));
        pageToken = response.data.nextPageToken;
      } while (pageToken);
      return events;
    }));
    return results.flat().sort((a, b) => {
      const left = a.start?.dateTime || a.start?.date || '';
      const right = b.start?.dateTime || b.start?.date || '';
      return left.localeCompare(right);
    });
  }

  async createEvent({ calendarId, resource }) {
    const api = this.getCalendarApi();
    await this.assertWritableCalendar(api, calendarId);
    const response = await api.events.insert({ calendarId, requestBody: resource, sendUpdates: 'all' });
    return { ...response.data, calendarId };
  }

  async updateEvent({ calendarId, eventId, resource }) {
    const api = this.getCalendarApi();
    await this.assertWritableCalendar(api, calendarId);
    if (!eventId) throw new Error('Не выбрано событие для редактирования');
    const response = await api.events.patch({ calendarId, eventId, requestBody: resource, sendUpdates: 'all' });
    return { ...response.data, calendarId };
  }

  async deleteEvent({ calendarId, eventId }) {
    const api = this.getCalendarApi();
    await this.assertWritableCalendar(api, calendarId);
    if (!eventId) throw new Error('Не выбрано событие для удаления');
    await api.events.delete({ calendarId, eventId });
    return { deleted: true };
  }

  async assertWritableCalendar(api, calendarId) {
    if (!calendarId) throw new Error('Выберите календарь');
    const response = await api.calendarList.get({ calendarId });
    if (!['owner', 'writer'].includes(response.data.accessRole)) {
      throw new Error('Этот календарь доступен только для чтения');
    }
  }
}

module.exports = { GoogleCalendarService };
