'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('status requires a password and shows failures without private log text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-status-'));
  const socket = path.join(dir, 'docker.sock');
  const passwordFile = path.join(dir, 'password');
  const usersFile = path.join(dir, 'users.json');
  fs.writeFileSync(passwordFile, 'test-password');
  const salt = crypto.randomBytes(32);
  fs.writeFileSync(usersFile, JSON.stringify({ stepan: {
    salt: salt.toString('hex'),
    hash: crypto.scryptSync('test-stepan-password', salt, 64).toString('hex'),
  } }));
  let dockerCalls = 0;
  const docker = http.createServer((req, res) => {
    dockerCalls++;
    if (req.url === '/containers/json?all=1') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ Id: 'bot123', Names: ['/reservation-receipt-bot'] }]));
    } else if (req.url === '/containers/bot123/json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        Name: '/reservation-receipt-bot', Config: { Tty: false, Labels: {
          'com.docker.compose.project': 'reservation-service',
          'com.docker.compose.service': 'bot',
        } },
        State: { Status: 'running', StartedAt: '2026-11-10T08:00:00Z', OOMKilled: false },
        RestartCount: 2,
      }));
    } else if (req.url === '/containers/severbus-backend/json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ Config: { Env: ['ADMIN_TOKEN=test-token'] } }));
    } else if (req.url.startsWith('/containers/bot123/logs?')) {
      const payload = Buffer.from('2026-11-10T08:10:00Z telegram.error.TimedOut test@example.com 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ\n');
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(payload.length, 4);
      res.end(Buffer.concat([header, payload]));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => docker.listen(socket, resolve));
  const severbus = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    assert.match(req.url, /^\/api\/logs\?/);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ total: 1, logs: [{
      created_at: '2026-11-10 08:15:00', level: 'error', method: 'GET',
      url: '/api/schedule', status_code: 500, duration_ms: 42,
      error_message: 'FetchError test@example.com',
    }] }));
  });
  await new Promise((resolve) => severbus.listen(0, '127.0.0.1', resolve));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DOCKER_SOCKET: socket,
      STATUS_PASSWORD_FILE: passwordFile, STATUS_USERS_FILE: usersFile,
      SEVERBUS_HOST: '127.0.0.1',
      SEVERBUS_PORT: String(severbus.address().port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('exit', (code) => reject(new Error('status server exited: ' + code)));
    });
    const url = 'http://127.0.0.1:' + port + '/server-status/';
    const denied = await fetch(url);
    assert.equal(denied.status, 401);
    const deniedLogs = await fetch(url + 'logs/');
    assert.equal(deniedLogs.status, 401);
    const deniedApi = await fetch(url + 'api/logs');
    assert.equal(deniedApi.status, 401);
    assert.equal(dockerCalls, 0);
    const auth = (username, password) => ({
      Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
    });
    const headers = auth('status', 'test-password');
    for (const credentials of [auth('someone', 'test-password'),
      auth('stepan', 'test-password'), auth('stepan', 'wrong-password')]) {
      const deniedUser = await fetch(url, { headers: credentials });
      assert.equal(deniedUser.status, 401);
    }
    assert.equal(dockerCalls, 0);
    const accepted = await fetch(url, {
      headers,
    });
    assert.equal(accepted.status, 200);
    const html = await accepted.text();
    assert.match(html, /reservation-receipt-bot/);
    assert.match(html, /TimedOut/);
    assert.match(html, /Контейнер отсутствует/);
    assert.match(html, /Состояние системы/);
    assert.match(html, /Логи сервисов/);
    assert.match(html, /id="log-filters"/);
    assert.match(html, /addEventListener\('change'/);
    assert.match(html, /id="log-results"/);
    assert.doesNotMatch(html, /test@example.com|123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
    assert.match(html, /\[email\]|\[токен\]/);
    assert.equal(dockerCalls, 6);
    const logs = await fetch(url + '?service=reservation-receipt-bot&level=error&q=TimedOut&since=all', {
      headers,
    });
    assert.equal(logs.status, 200);
    const logHtml = await logs.text();
    assert.match(logHtml, /Логи сервисов/);
    assert.match(logHtml, /Состояние системы/);
    assert.match(logHtml, /TimedOut/);
    assert.match(logHtml, /Брат бухгалтер/);
    assert.match(logHtml, /data-status="Работает" data-style="good" selected/);
    assert.doesNotMatch(logHtml, /test@example.com|123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
    const api = await fetch(url + 'api/logs?service=reservation-receipt-bot&level=error&q=TimedOut&since=all', {
      headers,
    });
    assert.equal(api.status, 200);
    const apiHtml = await api.text();
    assert.match(apiHtml, /TimedOut/);
    assert.doesNotMatch(apiHtml, /<html|Состояние системы/);
    const stepanApi = await fetch(url + 'api/logs?service=reservation-receipt-bot&since=all', {
      headers: auth('stepan', 'test-stepan-password'),
    });
    assert.equal(stepanApi.status, 200);
    assert.match(await stepanApi.text(), /TimedOut/);
    const stepanPage = await fetch(url, { headers: auth('stepan', 'test-stepan-password') });
    assert.equal(stepanPage.status, 200);
    assert.match(await stepanPage.text(), /Состояние системы/);
    const history = await fetch(url + '?service=severbus-requests&level=error', {
      headers,
    });
    assert.equal(history.status, 200);
    const historyHtml = await history.text();
    assert.match(historyHtml, /Severbus — история HTTP-запросов/);
    assert.match(historyHtml, /GET · \/api\/schedule · HTTP 500 · 42 мс/);
    assert.doesNotMatch(historyHtml, /test@example.com/);
    const legacy = await fetch(url + 'logs/?service=severbus-requests', {
      headers, redirect: 'manual',
    });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get('location'), '/server-status/?service=severbus-requests#logs');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => docker.close(resolve));
    await new Promise((resolve) => severbus.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
