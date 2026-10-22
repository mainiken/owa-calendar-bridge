// Only Google credentials pass through this service; calendar contents stay in the userscript.
'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

function createService({ clientId, clientSecret, encryptionKey, directory, origin = 'https://mainiken.github.io', fetchImpl = fetch, now = Date.now, audit = () => {} }) {
  const key = Buffer.from(encryptionKey || '', 'base64');
  if (!clientId || !clientSecret || key.length !== 32 || !directory) throw new Error('Missing OAuth service configuration');
  const active = new Map();
  function encrypt(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  }
  function decrypt(value) {
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString('utf8'));
  }
  const filename = session => path.join(directory, digest(session) + '.bin');
  async function save(session, record) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const target = filename(session), temp = target + '.' + crypto.randomUUID() + '.tmp';
    try { await fs.writeFile(temp, encrypt(record), { mode: 0o600 }); await fs.rename(temp, target); }
    finally { await fs.rm(temp, { force: true }); }
  }
  async function read(session) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(session || '')) throw new HttpError(401, 'reauthorize');
    try { return decrypt(await fs.readFile(filename(session))); }
    catch (error) { if (error.code === 'ENOENT') throw new HttpError(401, 'reauthorize'); throw error; }
  }
  async function googleToken(parameters) {
    let response;
    try {
      response = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...parameters }),
        signal: AbortSignal.timeout(20000), redirect: 'error'
      });
    } catch { throw new HttpError(503, 'google_unavailable'); }
    const data = await response.json();
    if (!response.ok) throw new HttpError(data.error === 'invalid_grant' ? 401 : 503, data.error === 'invalid_grant' ? 'reauthorize' : 'google_unavailable');
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in) || data.expires_in < 60) throw new HttpError(503, 'invalid_google_response');
    return data;
  }
  const publicCredential = record => ({ accessToken: record.accessToken, expires: record.expires, account: record.account, email: record.email });
  async function exchange(code) {
    if (typeof code !== 'string' || code.length < 10 || code.length > 4096 || /\s/.test(code)) throw new HttpError(400, 'invalid_code');
    const token = await googleToken({ code, grant_type: 'authorization_code', redirect_uri: origin });
    const scopes = new Set((token.scope || '').split(' '));
    const calendarGranted = scopes.has(CALENDAR_SCOPE), emailGranted = scopes.has(EMAIL_SCOPE) || scopes.has('email');
    if (!calendarGranted || !emailGranted) {
      audit({ event: 'oauth_missing_scopes', calendarGranted, emailGranted, scopePresent: typeof token.scope === 'string' });
      throw new HttpError(400, 'missing_scopes');
    }
    if (typeof token.refresh_token !== 'string' || !token.refresh_token) throw new HttpError(409, 'offline_access_required');
    const response = await fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(20000), redirect: 'error'
    });
    if (!response.ok) throw new HttpError(503, 'google_unavailable');
    const account = await response.json();
    if (typeof account.sub !== 'string' || !account.sub || typeof account.email !== 'string' || !account.email) throw new HttpError(503, 'invalid_google_response');
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const record = { refreshToken: token.refresh_token, accessToken: token.access_token, expires: now() + token.expires_in * 1000 - 60000, account: account.sub, email: account.email };
    await save(sessionToken, record);
    return { ...publicCredential(record), sessionToken };
  }
  async function withSession(session, operation) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(session || '')) throw new HttpError(401, 'reauthorize');
    const pending = (active.get(session) || Promise.resolve()).catch(() => {}).then(operation);
    active.set(session, pending);
    try { return await pending; } finally { if (active.get(session) === pending) active.delete(session); }
  }
  async function refresh(session, force = false) {
    return withSession(session, async () => {
      const record = await read(session);
      if (!force && record.expires > now()) return publicCredential(record);
      let token;
      try { token = await googleToken({ grant_type: 'refresh_token', refresh_token: record.refreshToken }); }
      catch (error) {
        if (error.status === 401) await fs.rm(filename(session), { force: true });
        throw error;
      }
      const next = { ...record, accessToken: token.access_token, expires: now() + token.expires_in * 1000 - 60000, refreshToken: token.refresh_token || record.refreshToken };
      await save(session, next);
      return publicCredential(next);
    });
  }
  async function disconnect(session) {
    return withSession(session, async () => {
      await read(session);
      await fs.rm(filename(session), { force: true });
    });
  }
  async function body(req) {
    let value = '';
    for await (const chunk of req) {
      value += chunk;
      if (Buffer.byteLength(value) > 8192) throw new HttpError(413, 'body_too_large');
    }
    try { return JSON.parse(value); } catch { throw new HttpError(400, 'invalid_json'); }
  }
  const attempts = new Map();
  async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => { res.writeHead(status); res.end(JSON.stringify(data)); };
    try {
      if (req.method === 'GET' && req.url === '/owa-calendar-auth/health') return send(200, { ok: true });
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      if (req.headers.origin !== origin || req.headers['x-requested-with'] !== 'OWACalendarBridge' || req.headers['content-type'] !== 'application/json') throw new HttpError(403, 'invalid_request');
      // No CORS/cookies: the isolated userscript sends credentials in a header.
      const data = await body(req);
      if (req.url === '/owa-calendar-auth/exchange') {
        const address = req.socket.remoteAddress;
        for (const [ip, limit] of attempts) if (limit.until <= now()) attempts.delete(ip);
        const limit = attempts.get(address) || { count: 0, until: now() + 60000 };
        attempts.set(address, limit);
        if (++limit.count > 20) throw new HttpError(429, 'rate_limited');
        return send(200, await exchange(data.code));
      }
      const session = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (req.url === '/owa-calendar-auth/token') return send(200, await refresh(session, data.force === true));
      if (req.url === '/owa-calendar-auth/disconnect') { await disconnect(session); return send(200, { ok: true }); }
      throw new HttpError(404, 'not_found');
    } catch (error) {
      const operation = ['/exchange', '/token', '/disconnect'].find(suffix => req.url === '/owa-calendar-auth' + suffix)?.slice(1) || 'other';
      const code = error instanceof HttpError ? error.message : 'service_unavailable';
      audit({ event: 'oauth_request_failed', operation, status: error.status || 503, code });
      send(error.status || 503, { error: code });
    }
  }
  return { handler, exchange, refresh, disconnect };
}
module.exports = { createService };
if (require.main === module) {
  const service = createService({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, encryptionKey: process.env.AUTH_ENCRYPTION_KEY, directory: process.env.AUTH_DATA_DIR || '/data', audit: event => console.warn(JSON.stringify(event)) });
  http.createServer(service.handler).listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('OAuth renewal service listening'));
}
