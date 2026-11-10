'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

const PREFIX = '/server-status/';
const PASSWORD_FILE = process.env.STATUS_PASSWORD_FILE || '/run/secrets/server-status-password';
const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const PORT = Number(process.env.PORT || 8080);
const EXPECTED = [
  ['reverse-proxy-nginx', 'reverse-proxy'],
  ['reverse-proxy-status', 'reverse-proxy'],
  ['reverse-proxy-certbot', 'reverse-proxy'],
  ['reservation-backend', 'reservation-service'],
  ['reservation-receipt-bot', 'reservation-service'],
  ['reservation-receipt-xray', 'reservation-service'],
  ['severbus-backend', 'severbus'],
];

function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let supplied;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    supplied = decoded.slice(decoded.indexOf(':') + 1);
  } catch {
    return false;
  }
  const expected = fs.readFileSync(PASSWORD_FILE, 'utf8').trimEnd();
  if (!expected) return false;
  const hash = (text) => crypto.createHash('sha256').update(text).digest();
  return crypto.timingSafeEqual(hash(supplied), hash(expected));
}

function docker(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, path, method: 'GET', timeout: 5000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2_000_000) return req.destroy(new Error('Docker response too large'));
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Docker API returned ' + res.statusCode));
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker API timeout')));
    req.on('error', reject);
    req.end();
  });
}

function logText(buffer, tty) {
  if (tty) return buffer.toString('utf8');
  let offset = 0;
  const chunks = [];
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) break;
    chunks.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : buffer.toString('utf8');
}

function lastError(logs) {
  let error = null;
  for (const line of logs.split(/\r?\n/)) {
    if (!/\b(?:ERROR|Error|Exception|Timeout|TimedOut|OOM|fatal|panic)\b/i.test(line)) continue;
    const type = line.match(/\b([A-Z][A-Za-z]*(?:Error|Exception|Timeout)|TimedOut)\b/);
    const time = line.match(/20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/);
    error = { type: type?.[1] || (/OOM/i.test(line) ? 'OOM' : 'Ошибка в журнале'), at: time?.[0] || null };
  }
  return error;
}

async function inspectContainer(item, since) {
  const details = JSON.parse((await docker('/containers/' + item.Id + '/json')).toString('utf8'));
  const state = details.State || {};
  const labels = details.Config?.Labels || {};
  let error = null;
  try {
    const raw = await docker('/containers/' + item.Id +
      '/logs?stdout=1&stderr=1&tail=200&since=' + since + '&timestamps=1');
    error = lastError(logText(raw, details.Config?.Tty));
  } catch {
    error = { type: 'Журнал недоступен', at: null };
  }
  return {
    group: labels['com.docker.compose.project'] || 'Другие контейнеры',
    name: labels['com.docker.compose.service'] || details.Name.replace(/^\//, ''),
    container: details.Name.replace(/^\//, ''),
    state: state.Status || 'unknown',
    health: state.Health?.Status || null,
    restarts: details.RestartCount || 0,
    oom: !!state.OOMKilled,
    startedAt: state.StartedAt || null,
    error,
  };
}

async function snapshot() {
  const list = JSON.parse((await docker('/containers/json?all=1')).toString('utf8'));
  const since = Math.floor(Date.now() / 1000) - 3600;
  const services = await Promise.all(list.map(async (item) => {
    try {
      return await inspectContainer(item, since);
    } catch {
      return {
        group: 'Другие контейнеры',
        name: item.Names?.[0]?.replace(/^\//, '') || item.Id.slice(0, 12),
        container: item.Names?.[0]?.replace(/^\//, '') || item.Id.slice(0, 12),
        state: 'unknown', health: null, restarts: 0, oom: false,
        startedAt: null, error: { type: 'Не удалось проверить контейнер', at: null },
      };
    }
  }));
  for (const [container, group] of EXPECTED) {
    if (services.some((service) => service.container === container)) continue;
    services.push({
      group, name: container, container, state: 'missing', health: null,
      restarts: 0, oom: false, startedAt: null,
      error: { type: 'Контейнер отсутствует', at: null },
    });
  }
  services.sort((a, b) => a.group.localeCompare(b.group, 'ru') || a.name.localeCompare(b.name, 'ru'));
  return { checkedAt: new Date().toISOString(), services };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function healthy(service) {
  return service.state === 'running' &&
    (service.health === null || service.health === 'healthy') && !service.oom;
}

function time(value) {
  if (!value || value.startsWith('0001-')) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    timeZone: 'Asia/Tomsk', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function render(data, problem) {
  const services = data?.services || [];
  const working = services.filter(healthy).length;
  const groups = new Map();
  for (const service of services) {
    if (!groups.has(service.group)) groups.set(service.group, []);
    groups.get(service.group).push(service);
  }
  const sections = [...groups].map(([group, items]) => `
  <section><h2>${escapeHtml(group)} <small>${items.length}</small></h2>
    <div class="grid">${items.map((s) => `
      <article class="${healthy(s) ? '' : 'bad'}">
        <header><div><h3>${escapeHtml(s.name)}</h3><div class="container">${escapeHtml(s.container)}</div></div>
          <strong class="pill ${healthy(s) ? 'good' : 'bad-pill'}">${healthy(s) ? 'Работает' : 'Проблема'}</strong></header>
        <dl><div><dt>Контейнер</dt><dd>${escapeHtml(s.state)}</dd></div>
          <div><dt>Health</dt><dd>${escapeHtml(s.health || 'нет пробы')}</dd></div>
          <div><dt>Перезапуски</dt><dd>${s.restarts}</dd></div>
          <div><dt>Память</dt><dd>${s.oom ? 'OOM' : 'OOM нет'}</dd></div>
          <div><dt>Запущен</dt><dd>${escapeHtml(time(s.startedAt))}</dd></div></dl>
        <div class="error"><span>Последняя ошибка за час</span>
          <b>${escapeHtml(s.error?.type || 'Не найдена')}</b>
          ${s.error?.at ? `<time>${escapeHtml(time(s.error.at))}</time>` : ''}</div>
      </article>`).join('')}</div></section>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow"><title>Состояние сервера</title>
  <style>
  :root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#101318;color:#eaf0f6}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top right,#1c2d37 0,#101318 45%)}
  main{max-width:1180px;margin:auto;padding:42px 24px 72px}main>header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;flex-wrap:wrap}
  .eyebrow{font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#7ba8b0}
  h1{font-size:clamp(32px,5vw,52px);line-height:1.05;margin:12px 0}h2{font-size:20px;margin:34px 0 16px}h2 small{font-size:13px;color:#94a4b5;margin-left:8px}
  .muted{color:#96a5b6;line-height:1.5;margin:0}.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;background:#d5f47a;color:#1c2a17;text-decoration:none;border-radius:12px;font-weight:750}
  .summary{display:flex;gap:14px;flex-wrap:wrap;margin:30px 0 4px}.metric{min-width:165px;background:#1c222a;border:1px solid #2b3540;border-radius:16px;padding:18px 21px}
  .metric b{display:block;font-size:29px;line-height:1}.metric span{display:block;margin-top:7px;color:#a3b0bd;font-size:13px}
  .alert{background:#492724;border:1px solid #a85d57;padding:17px 20px;border-radius:13px;margin-top:28px;color:#ffe4df}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:15px}article{background:#1c222a;border:1px solid #303a45;border-radius:18px;padding:21px;min-width:0}article.bad{border-color:#85504e}
  article header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}h3{font-size:18px;margin:0 0 5px;overflow-wrap:anywhere}.container{font-size:12px;color:#91a0af;overflow-wrap:anywhere}
  .pill{white-space:nowrap;border-radius:100px;padding:5px 10px;font-size:12px}.good{background:#244c3b;color:#a5efbb}.bad-pill{background:#59312f;color:#ffc0b9}
  dl{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin:23px 0 20px}dt{font-size:12px;color:#91a0af}dd{margin:5px 0 0;font-size:14px;overflow-wrap:anywhere}
  .error{border-top:1px solid #303a45;padding-top:15px;display:flex;flex-wrap:wrap;gap:5px 10px;align-items:center;font-size:12px;color:#91a0af}.error b{color:#eaf0f6;font-size:13px}.error time{margin-left:auto}
  footer{margin-top:36px;color:#778898;font-size:12px}@media(max-width:600px){main{padding:27px 16px 48px}.metric{flex:1;min-width:135px}.grid{grid-template-columns:1fr}}
  </style></head><body><main>
  <header><div><span class="eyebrow">Сервер · все сервисы</span><h1>Состояние системы</h1>
    <p class="muted">Срез на ${escapeHtml(time(data?.checkedAt || new Date().toISOString()))} по Томску. Данные обновляются при открытии страницы.</p></div>
    <a class="button" href="${PREFIX}">Обновить сейчас</a></header>
  ${problem ? `<div class="alert">Docker недоступен: ${escapeHtml(problem)}. Состояние сервисов неизвестно.</div>` : ''}
  <div class="summary"><div class="metric"><b>${services.length}</b><span>контейнеров</span></div>
    <div class="metric"><b>${working}</b><span>работают</span></div>
    <div class="metric"><b>${services.length - working}</b><span>с проблемой</span></div></div>
  ${sections || '<p class="muted" style="margin-top:30px">Контейнеры не найдены.</p>'}
  <footer>Источник: Docker на этом сервере. Показаны только типы ошибок, без содержимого журналов.</footer>
  </main></body></html>`;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.method !== 'GET' || req.url !== PREFIX) return res.writeHead(404).end('Not found');
  try {
    if (!authorized(req)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Server status", charset="UTF-8"');
      return res.writeHead(401).end('Требуется пароль');
    }
  } catch {
    return res.writeHead(503).end('Пароль страницы не настроен');
  }
  try {
    const data = await snapshot();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(render(data, null));
  } catch (error) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(render(null, error.code || error.message || 'ошибка соединения'));
  }
});

server.listen(PORT, '0.0.0.0', () => console.log('Server status listening on ' + PORT));

module.exports = { lastError, logText, healthy, render };
