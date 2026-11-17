import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('/data/progress.db');
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS progress (
    player TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    snapshot TEXT NOT NULL
  );
`);
const readSave = db.prepare('SELECT revision, snapshot FROM progress WHERE player = ?');
const writeSave = db.prepare(`
  INSERT INTO progress(player, revision, snapshot) VALUES (?, 1, ?)
  ON CONFLICT(player) DO UPDATE SET revision = progress.revision + 1, snapshot = excluded.snapshot
  WHERE progress.revision = ?
  RETURNING revision
`);
const deleteSave = db.prepare('DELETE FROM progress WHERE player = ?');

const sessions = new Map();
const sessionHours = 24;
const maxSessions = 10000;
const maxBody = 256 * 1024;
const vkId = /^[1-9][0-9]{0,19}$/;
const saveKey = /^dlv-[a-zA-Z0-9_-]{1,75}$/;

class RequestError extends Error {
  constructor (status) { super(String(status)); this.status = status; }
}

function configuration () {
  try {
    const [id, secret] = readFileSync('/run/bird-pizza/vk-config', 'utf8').trimEnd().split('\n');
    if (vkId.test(id) && secret) return { id, secret };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read VK game configuration');
  }
  throw new RequestError(503);
}

function verifyLaunch (launch, { id, secret }) {
  if (typeof launch !== 'string' || launch.length > 8192) throw new RequestError(400);
  const params = new URLSearchParams(launch);
  const seen = new Set();
  for (const [key] of params) {
    if (key !== 'sign' && !key.startsWith('vk_')) continue;
    if (seen.has(key)) throw new RequestError(401);
    seen.add(key);
  }
  const player = params.get('vk_user_id');
  const signature = params.get('sign') || '';
  if (params.get('vk_app_id') !== id || !vkId.test(player) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    throw new RequestError(401);
  }
  if (params.has('vk_ts')) {
    const issuedAt = Number(params.get('vk_ts'));
    const age = Date.now() / 1000 - issuedAt;
    if (!Number.isSafeInteger(issuedAt) || age < -300 || age > sessionHours * 3600) throw new RequestError(401);
  }
  params.sort();
  // VK encodes spaces as %20 in the signed string.
  const payload = [...params].filter(([key]) => key.startsWith('vk_'))
    .map(([key, value]) => key + '=' + encodeURIComponent(value)).join('&');
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw new RequestError(401);
  return player;
}

function expireSessions () {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiry <= now) sessions.delete(token);
  }
}
setInterval(expireSessions, 60000).unref();

async function readJSON (req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new RequestError(415);
  if (Number(req.headers['content-length']) > maxBody) throw new RequestError(413);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw new RequestError(413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400); }
}

function reply (res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handle (req, res) {
  const path = req.url;
  if (path === '/health' && req.method === 'GET') {
    let configured = false;
    try { configuration(); configured = true; } catch { /* Visible to deployment without exposing credentials. */ }
    return reply(res, 200, { configured });
  }
  if (path === '/session' && req.method === 'POST') {
    const body = await readJSON(req);
    const player = verifyLaunch(body?.launch, configuration());
    if (sessions.size >= maxSessions) expireSessions();
    if (sessions.size >= maxSessions) throw new RequestError(503);
    const token = randomBytes(32).toString('base64url');
    const row = readSave.get(player);
    sessions.set(token, { player, expiry: Date.now() + sessionHours * 3600000 });
    return reply(res, 200, {
      token, player, revision: row?.revision || 0, snapshot: row ? JSON.parse(row.snapshot) : {},
    });
  }
  if (path !== '/progress' || !['PUT', 'DELETE'].includes(req.method)) throw new RequestError(404);

  const token = (req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const session = sessions.get(token);
  if (!session || session.expiry <= Date.now()) throw new RequestError(401);
  if (req.method === 'DELETE') {
    deleteSave.run(session.player);
    for (const [id, item] of sessions) {
      if (item.player === session.player) sessions.delete(id);
    }
    return reply(res, 200, {});
  }
  const body = await readJSON(req);
  // A delete may have revoked the session while the body was arriving.
  if (!sessions.has(token)) throw new RequestError(401);
  const { revision, snapshot } = body || {};
  if (!Number.isSafeInteger(revision) || revision < 0 || !snapshot || typeof snapshot !== 'object' ||
      Array.isArray(snapshot) || Object.keys(snapshot).length > 256 ||
      Object.entries(snapshot).some(([key, value]) => !saveKey.test(key) || typeof value !== 'string')) {
    throw new RequestError(400);
  }

  const row = readSave.get(session.player);
  if ((row?.revision || 0) !== revision) {
    // The response may have been lost after a successful write.
    if (row?.revision === revision + 1 && row.snapshot === JSON.stringify(snapshot)) {
      return reply(res, 200, { revision: row.revision });
    }
    return reply(res, 409, { revision: row?.revision || 0 });
  }
  const updated = writeSave.get(session.player, JSON.stringify(snapshot), revision);
  return reply(res, 200, { revision: updated.revision });
}

createServer({ requestTimeout: 10000, headersTimeout: 5000 }, (req, res) => {
  handle(req, res).catch(error => {
    if (!error.status) console.error('Bird Pizza request failed', error.code || error.name);
    if (!res.destroyed && !res.headersSent) reply(res, error.status || 500, { error: true });
  });
}).listen(8081, '0.0.0.0');
