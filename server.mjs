import http from 'node:http';
import { translations } from './public/i18n.mjs';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:18000/v1';
const MODEL = 'qwen3-235b';
const TTL = 60 * 60 * 1000;
const ASSETS = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/i18n.mjs', ['i18n.mjs', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);

class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// Only the test harness injects a transport. No configurable upstream URL exists.
export function createApp({ transport = fetch, timeoutMs = 120000 } = {}) {
  const sessions = new Map();
  const forget = s => { s.active?.controller.abort(); s.active = null; s.key = ''; };
  const expiry = setInterval(() => {
    for (const [id, s] of sessions) if (Date.now() - s.touched > TTL) { forget(s); sessions.delete(id); }
  }, 60000).unref();
  function send(res, status, value) {
    if (!res.destroyed) { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
  }
  async function body(req) {
    let chunks = [], bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 512000) throw new AppError(413, 'too_large', translations.en.errors.too_large);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AppError(400, 'bad_json', translations.en.errors.bad_json); }
  }
  function state(s) { return {hasKey: Boolean(s.key), connection: s.connection, baseUrl: BASE, model: MODEL}; }
  async function upstream(s, path, options = {}, active) {
    const controller = active?.controller ?? new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await transport(BASE + path, {
        ...options, signal: controller.signal, redirect: 'error',
        headers: {'Authorization': `Bearer ${s.key}`, 'Content-Type': 'application/json'}
      });
      if (response.status === 401 || response.status === 403) {
        s.connection = 'unauthorized';
        throw new AppError(401, 'unauthorized', translations.en.errors.unauthorized);
      }
      if (!response.ok) {
        s.connection = 'error';
        throw new AppError(502, 'upstream_error', translations.en.errors.upstream_error);
      }
      // Upstream error bodies are never forwarded, since they may contain secrets.
      return await response.json();
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) {
        if (!timedOut) throw new AppError(409, 'cancelled', translations.en.errors.cancelled);
        s.connection = 'timeout';
        throw new AppError(504, 'timeout', translations.en.errors.timeout);
      }
      s.connection = 'unreachable';
      throw new AppError(502, 'unreachable', translations.en.errors.unreachable);
    } finally { clearTimeout(timer); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.host !== origin.slice(7)) throw new AppError(403, 'host', translations.en.errors.host);
      if (req.headers.origin && req.headers.origin !== origin) throw new AppError(403, 'origin', translations.en.errors.origin);
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new AppError(403, 'origin', translations.en.errors.origin);
      const path = req.url;
      if (req.method === 'GET' && ASSETS.has(path)) {
        const [file, mime] = ASSETS.get(path);
        res.writeHead(200, {'Content-Type': mime});
        res.end(await readFile(new URL(`public/${file}`, import.meta.url))); return;
      }
      if (!path.startsWith('/api/')) throw new AppError(404, 'not_found', translations.en.errors.not_found);
      let sid = req.headers.cookie?.match(/(?:^|;\s*)mercury_session=([a-f0-9]{48})(?:;|$)/)?.[1];
      let s = sessions.get(sid);
      if (s && Date.now() - s.touched > TTL) { forget(s); sessions.delete(sid); s = null; }
      if (!s && req.method === 'GET' && path === '/api/session') {
        if (sessions.size >= 100) throw new AppError(503, 'sessions', translations.en.errors.sessions);
        sid = randomBytes(24).toString('hex');
        s = {key: '', csrf: randomBytes(24).toString('hex'), connection: 'missing', touched: Date.now(), active: null};
        sessions.set(sid, s);
        res.setHeader('Set-Cookie', `mercury_session=${sid}; HttpOnly; SameSite=Strict; Path=/`);
      }
      if (!s) throw new AppError(401, 'session_expired', translations.en.errors.session_expired);
      s.touched = Date.now();
      if (req.method === 'GET' && path === '/api/session') { send(res, 200, {...state(s), csrf: s.csrf}); return; }
      if (req.method !== 'POST') throw new AppError(405, 'method', translations.en.errors.method);
      if (req.headers.origin !== origin || req.headers['x-csrf-token'] !== s.csrf || !req.headers['content-type']?.startsWith('application/json')) throw new AppError(403, 'csrf', translations.en.errors.csrf);
      const data = await body(req);
      if (path === '/api/key') {
        if (s.active) throw new AppError(409, 'busy', translations.en.errors.busy);
        if (typeof data.key !== 'string' || data.key.length < 1 || data.key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(data.key)) throw new AppError(400, 'key', translations.en.errors.key);
        s.key = data.key; s.connection = 'unverified'; send(res, 200, state(s)); return;
      }
      if (path === '/api/forget') {
        forget(s); s.connection = 'missing'; send(res, 200, state(s)); return;
      }
      if (path === '/api/cancel' || path === '/api/new') {
        if (path === '/api/new' || s.active?.id === data.id) { s.active?.controller.abort(); s.active = null; }
        send(res, 200, {ok: true}); return;
      }
      if (!s.key) throw new AppError(401, 'missing_key', translations.en.errors.missing_key);
      if (s.active) throw new AppError(409, 'busy', translations.en.errors.busy);
      if (path !== '/api/chat' && path !== '/api/check') throw new AppError(404, 'not_found', translations.en.errors.not_found);
      if (typeof data.id !== 'string' || !/^[\w-]{1,80}$/.test(data.id)) throw new AppError(400, 'id', translations.en.errors.id);
      if (path === '/api/chat') {
        if (!Array.isArray(data.messages) || !data.messages.length || data.messages.length > 200 || data.messages.some((m, i) => !m || m.role !== (i % 2 ? 'assistant' : 'user') || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 100000) || data.messages.at(-1).role !== 'user') throw new AppError(400, 'messages', translations.en.errors.messages);
      }
      const active = {id: data.id, controller: new AbortController()}; s.active = active;
      const disconnect = () => { if (!res.writableEnded) active.controller.abort(); };
      res.on('close', disconnect);
      try {
        if (path === '/api/check') {
          const result = await upstream(s, '/models', {}, active);
          if (!Array.isArray(result.data) || !result.data.some(m => m.id === MODEL)) throw new AppError(502, 'model', translations.en.errors.model);
          if (active.controller.signal.aborted) throw new AppError(409, 'cancelled', translations.en.errors.cancelled);
          s.connection = 'available'; send(res, 200, state(s));
        } else {
          const result = await upstream(s, '/chat/completions', {method: 'POST', body: JSON.stringify({model: MODEL, messages: data.messages.map(m => ({role: m.role, content: m.content})), stream: false, max_tokens: 2048})}, active);
          if (active.controller.signal.aborted) throw new AppError(409, 'cancelled', translations.en.errors.cancelled);
          const content = result.choices?.[0]?.message?.content;
          if (typeof content !== 'string' || !content.trim()) throw new AppError(502, 'empty', translations.en.errors.empty);
          // Defensive masking prevents an echoed bearer key from reaching the page.
          const safe = content.split(s.key).join('[API key hidden]');
          s.connection = 'verified'; send(res, 200, {content: safe, truncated: result.choices[0].finish_reason === 'length', connection: s.connection});
        }
      } finally { res.off('close', disconnect); if (s.active === active) s.active = null; }
    } catch (error) {
      const known = error instanceof AppError;
      send(res, known ? error.status : 500, {error: {code: known ? error.code : 'internal', message: translations[req.headers['x-language'] === 'zh' ? 'zh' : 'en'].errors[known ? error.code : 'internal'] || translations.en.errors.internal}});
    }
  });
  server.on('close', () => { clearInterval(expiry); for (const s of sessions.values()) forget(s); sessions.clear(); });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 7860);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
  const server = createApp();
  server.listen(port, '127.0.0.1', () => console.log(`mercury chat: http://127.0.0.1:${port}`));
  server.on('error', () => { console.error('Unable to start local chat. The selected port may already be in use.'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
