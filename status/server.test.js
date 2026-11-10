'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
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
  fs.writeFileSync(passwordFile, 'test-password');
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
    } else if (req.url.startsWith('/containers/bot123/logs?')) {
      const payload = Buffer.from('2026-11-10T08:10:00Z telegram.error.TimedOut Катя secret-data\n');
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(payload.length, 4);
      res.end(Buffer.concat([header, payload]));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => docker.listen(socket, resolve));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DOCKER_SOCKET: socket,
      STATUS_PASSWORD_FILE: passwordFile },
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
    assert.equal(dockerCalls, 0);
    const accepted = await fetch(url, {
      headers: { Authorization: 'Basic ' + Buffer.from('status:test-password').toString('base64') },
    });
    assert.equal(accepted.status, 200);
    const html = await accepted.text();
    assert.match(html, /reservation-receipt-bot/);
    assert.match(html, /TimedOut/);
    assert.match(html, /Контейнер отсутствует/);
    assert.doesNotMatch(html, /secret-data|Катя/);
    assert.equal(dockerCalls, 3);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => docker.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
