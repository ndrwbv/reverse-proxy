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
const NAMES = {
  'reverse-proxy-nginx': 'Веб-прокси Nginx',
  'reverse-proxy-status': 'Страница состояния',
  'reverse-proxy-certbot': 'Сертификаты',
  'reservation-backend': 'Slotik — бэкенд и бот записи',
  'reservation-receipt-bot': 'Брат бухгалтер — квитанции',
  'reservation-receipt-xray': 'Xray — связь бота с Telegram',
  'severbus-backend': 'Severbus — бэкенд',
  'severbus-requests': 'Severbus — история HTTP-запросов',
};
const GROUPS = {
  'reverse-proxy': 'Доступ к сайтам',
  'reservation-service': 'Slotik и квитанции',
  severbus: 'Severbus',
};
const HTTP_PROBES = {
  'reverse-proxy-nginx': { host: 'reverse-proxy-nginx', port: 80, path: '/',
    headers: { Host: 'slotik.tech' }, expected: [301] },
  'reservation-backend': { host: 'reservation-backend', port: 3000,
    path: '/health', expected: [200] },
  'severbus-backend': { host: 'severbus-backend', port: 3000,
    path: '/api/health', expected: [200, 401] },
};
const LOG_PERIODS = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, all: null };
const LOG_LEVELS = new Set(['all', 'error', 'warn', 'info']);
const SEVERBUS_REQUESTS = 'severbus-requests';

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

function httpJson(host, port, path, authorization) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: 'GET', timeout: 5000,
      headers: { Authorization: authorization } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2_000_000) return req.destroy(new Error('Response too large'));
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Severbus API returned ' + res.statusCode));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Invalid Severbus API response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Severbus API timeout')));
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
    error = { type: type?.[1] || (/OOM/i.test(line) ? 'OOM' : 'Ошибка в журнале'),
      at: time?.[0] || null, line: redact(line) };
  }
  return error;
}

function redact(line, max = 500) {
  return line.replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[токен]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '[авторизация]')
    .replace(/\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[скрыто]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\+7[\s()-]*\d(?:[\s()-]*\d){9}/g, '[телефон]')
    .slice(0, max);
}

function recentLines(logs) {
  return logs.split(/\r?\n/).filter(Boolean).slice(-30).map(redact);
}

function logLevel(message) {
  if (/"level"\s*:\s*(?:50|60)|"level"\s*:\s*"error"|\b(?:ERROR|TimedOut|fatal|panic|Traceback|[A-Z][A-Za-z]*(?:Error|Exception|Timeout))\b/i.test(message)) return 'error';
  if (/"level"\s*:\s*40|"level"\s*:\s*"warn"|\b(?:WARN|WARNING)\b/i.test(message)) return 'warn';
  return 'info';
}

function parseLogEntries(raw, container) {
  return raw.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?Z\s*(.*)$/);
    const at = match ? match[1] + 'Z' : null;
    const message = redact(match ? match[2] : line, 1000);
    return { at, container, service: NAMES[container] || container,
      level: logLevel(message), message };
  });
}

async function severbusRequestEntries({ period, level, search, page, available }) {
  const details = JSON.parse((await docker('/containers/severbus-backend/json')).toString('utf8'));
  const tokenEntry = details.Config?.Env?.find((value) => value.startsWith('ADMIN_TOKEN='));
  const token = tokenEntry?.slice('ADMIN_TOKEN='.length);
  if (!token) throw new Error('Severbus ADMIN_TOKEN недоступен');
  const params = new URLSearchParams({ limit: '100', offset: String((page - 1) * 100) });
  if (period !== 'all') params.set('since', period);
  if (level !== 'all') params.set('level', level);
  if (search) params.set('search', search);
  const response = await httpJson(process.env.SEVERBUS_HOST || 'severbus-backend',
    Number(process.env.SEVERBUS_PORT || 3000), '/api/logs?' + params, 'Bearer ' + token);
  const entries = (response.logs || []).map((row) => {
    const rawTime = row.created_at ? String(row.created_at).replace(' ', 'T') : null;
    const at = rawTime ? (/Z$|[+-]\d\d:?\d\d$/.test(rawTime) ? rawTime : rawTime + 'Z') : null;
    const headline = [row.method, row.url, row.status_code ? 'HTTP ' + row.status_code : null,
      row.duration_ms != null ? row.duration_ms + ' мс' : null].filter(Boolean).join(' · ');
    const message = [headline, row.error_message, row.error_stack].filter(Boolean).join('\n');
    return { at, container: SEVERBUS_REQUESTS, service: 'Severbus — HTTP запросы',
      level: row.level === 'error' || row.level === 'warn' ? row.level : 'info',
      message: redact(message, 1500) };
  });
  return { entries, total: response.total || 0, page, limit: 100,
    period, level, service: SEVERBUS_REQUESTS, search, available };
}

async function logEntries(query) {
  const period = Object.hasOwn(LOG_PERIODS, query.get('since')) ? query.get('since') : '24h';
  const level = LOG_LEVELS.has(query.get('level')) ? query.get('level') : 'all';
  const service = query.get('service') || '';
  const search = (query.get('q') || '').trim().slice(0, 100).toLocaleLowerCase('ru');
  const page = Math.max(1, Math.min(1000, Number.parseInt(query.get('page'), 10) || 1));
  const since = LOG_PERIODS[period] === null ? '' :
    '&since=' + (Math.floor(Date.now() / 1000) - LOG_PERIODS[period]);
  const list = JSON.parse((await docker('/containers/json?all=1')).toString('utf8'))
    .filter(managed);
  const available = [...new Set([
    ...EXPECTED.map(([name]) => name),
    ...list.map((item) => item.Names?.[0]?.replace(/^\//, '')).filter(Boolean),
    SEVERBUS_REQUESTS,
  ])].sort();
  if (service === SEVERBUS_REQUESTS) {
    return severbusRequestEntries({ period, level, search, page, available });
  }
  const selected = list.filter((item) => !service || item.Names?.includes('/' + service));
  const batches = await Promise.all(selected.map(async (item) => {
    const container = item.Names[0].replace(/^\//, '');
    try {
      const inspect = JSON.parse((await docker('/containers/' + item.Id + '/json')).toString('utf8'));
      const raw = await docker('/containers/' + item.Id +
        '/logs?stdout=1&stderr=1&tail=500&timestamps=1' + since);
      return parseLogEntries(logText(raw, inspect.Config?.Tty), container);
    } catch {
      return [{ at: null, container, service: NAMES[container] || container,
        level: 'error', message: 'Не удалось прочитать журнал контейнера' }];
    }
  }));
  const filtered = batches.flat().filter((entry) =>
    (level === 'all' || entry.level === level) &&
    (!search || (entry.message + ' ' + entry.service).toLocaleLowerCase('ru').includes(search)));
  filtered.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const limit = 100;
  return { entries: filtered.slice((page - 1) * limit, page * limit),
    total: filtered.length, page, limit, period, level, service, search, available };
}

function managed(item) {
  if (item.Names?.some((name) => EXPECTED.some(([expected]) => name === '/' + expected))) return true;
  const labels = item.Labels || {};
  return !!labels['com.docker.compose.project'] &&
    !/^(true|1)$/i.test(labels['com.docker.compose.oneoff'] || '') &&
    !item.Names?.some((name) => /-run-[a-z0-9]+$/.test(name));
}

function probeHttp(config) {
  return new Promise((resolve) => {
    const req = http.request({ host: config.host, port: config.port, path: config.path,
      headers: config.headers, method: 'GET', timeout: 3000 }, (res) => {
      res.resume();
      resolve({ ok: config.expected.includes(res.statusCode),
        result: res.statusCode === 401 ? 'HTTP 401 · вход защищён' : 'HTTP ' + res.statusCode });
    });
    req.on('timeout', () => req.destroy(new Error('Тайм-аут')));
    req.on('error', (error) => resolve({ ok: false, result: error.message === 'Тайм-аут'
      ? 'Тайм-аут' : 'Нет соединения' }));
    req.end();
  });
}

async function inspectContainer(item) {
  const details = JSON.parse((await docker('/containers/' + item.Id + '/json')).toString('utf8'));
  const state = details.State || {};
  const labels = details.Config?.Labels || {};
  const container = details.Name.replace(/^\//, '');
  const probe = HTTP_PROBES[container] && state.Status === 'running'
    ? await probeHttp(HTTP_PROBES[container]) : null;
  let error = null;
  let logs = [];
  try {
    const raw = await docker('/containers/' + item.Id +
      '/logs?stdout=1&stderr=1&tail=120&timestamps=1');
    const text = logText(raw, details.Config?.Tty);
    error = lastError(text);
    logs = recentLines(text);
  } catch {
    error = { type: 'Журнал недоступен', at: null };
  }
  return {
    group: labels['com.docker.compose.project'] || 'Другие контейнеры',
    name: NAMES[container] || labels['com.docker.compose.service'] || container,
    container,
    state: state.Status || 'unknown',
    health: state.Health?.Status || null,
    restarts: details.RestartCount || 0,
    oom: !!state.OOMKilled,
    startedAt: state.StartedAt || null,
    probe,
    error,
    logs,
  };
}

async function snapshot() {
  const list = JSON.parse((await docker('/containers/json?all=1')).toString('utf8'));
  const services = await Promise.all(list.filter(managed).map(async (item) => {
    try {
      return await inspectContainer(item);
    } catch {
      return {
        group: 'Другие контейнеры',
        name: NAMES[item.Names?.[0]?.replace(/^\//, '')] ||
          item.Names?.[0]?.replace(/^\//, '') || item.Id.slice(0, 12),
        container: item.Names?.[0]?.replace(/^\//, '') || item.Id.slice(0, 12),
        state: 'unknown', health: null, restarts: 0, oom: false,
        startedAt: null, probe: null,
        error: { type: 'Не удалось проверить контейнер', at: null }, logs: [],
      };
    }
  }));
  for (const [container, group] of EXPECTED) {
    if (services.some((service) => service.container === container)) continue;
    services.push({
      group, name: NAMES[container] || container, container, state: 'missing', health: null,
      restarts: 0, oom: false, startedAt: null, probe: null,
      error: { type: 'Контейнер отсутствует', at: null }, logs: [],
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
    (service.health === null || service.health === 'healthy') &&
    service.probe?.ok !== false && !service.oom;
}

function recentError(service) {
  const at = Date.parse(service.error?.at || '');
  return Number.isFinite(at) && Date.now() - at < 3600_000;
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

function render(data, logs, problem, logsProblem) {
  const services = data?.services || [];
  const working = services.filter(healthy).length;
  const warnings = services.filter((service) => healthy(service) && recentError(service)).length;
  const groups = new Map();
  for (const service of services) {
    if (!groups.has(service.group)) groups.set(service.group, []);
    groups.get(service.group).push(service);
  }
  const sections = [...groups].map(([group, items]) => `
  <section><h2>${escapeHtml(GROUPS[group] || group)} <small>${items.length}</small></h2>
    <div class="grid">${items.map((s) => `
      <article class="${healthy(s) ? (recentError(s) ? 'warn' : '') : 'bad'}">
        <header><div><h3>${escapeHtml(s.name)}</h3><div class="container">${escapeHtml(s.container)}</div></div>
          <strong class="pill ${healthy(s) ? (recentError(s) ? 'warn-pill' : 'good') : 'bad-pill'}">${healthy(s) ? (recentError(s) ? 'Есть ошибки' : 'Работает') : 'Проблема'}</strong></header>
        <dl><div><dt>Контейнер</dt><dd>${escapeHtml(s.state)}</dd></div>
          <div><dt>Health</dt><dd>${escapeHtml(s.health || 'нет пробы')}</dd></div>
          ${s.probe ? `<div><dt>Ответ сервиса</dt><dd>${escapeHtml(s.probe.result)}</dd></div>` : ''}
          <div><dt>Перезапуски</dt><dd>${s.restarts}</dd></div>
          <div><dt>Память</dt><dd>${s.oom ? 'OOM' : 'OOM нет'}</dd></div>
          <div><dt>Запущен</dt><dd>${escapeHtml(time(s.startedAt))}</dd></div></dl>
        <div class="error"><span>Последняя ошибка в журнале</span>
          <b>${escapeHtml(s.error?.type || 'Не найдена')}</b>
          ${s.error?.at ? `<time>${escapeHtml(time(s.error.at))}</time>` : ''}
          ${s.error?.line ? `<code>${escapeHtml(s.error.line)}</code>` : ''}</div>
        <a class="service-link" href="${PREFIX}?service=${encodeURIComponent(s.container)}#logs">Смотреть логи сервиса →</a>
      </article>`).join('')}</div></section>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow"><title>Состояние сервера</title>
  <style>
  :root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#101318;color:#eaf0f6}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top right,#1c2d37 0,#101318 45%)}
  main{max-width:1380px;margin:auto;padding:42px 24px 72px}main>header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;flex-wrap:wrap}
  .eyebrow{font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#7ba8b0}
  h1{font-size:clamp(32px,5vw,52px);line-height:1.05;margin:12px 0}h2{font-size:20px;margin:34px 0 16px}h2 small{font-size:13px;color:#94a4b5;margin-left:8px}
  .muted{color:#96a5b6;line-height:1.5;margin:0}.actions{display:flex;gap:10px;flex-wrap:wrap}.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;background:#d5f47a;color:#1c2a17;text-decoration:none;border-radius:12px;font-weight:750}.button.secondary{background:#293440;color:#eaf0f6}
  .summary{display:flex;gap:14px;flex-wrap:wrap;margin:30px 0 4px}.metric{min-width:165px;background:#1c222a;border:1px solid #2b3540;border-radius:16px;padding:18px 21px}
  .metric b{display:block;font-size:29px;line-height:1}.metric span{display:block;margin-top:7px;color:#a3b0bd;font-size:13px}
  .alert{background:#492724;border:1px solid #a85d57;padding:17px 20px;border-radius:13px;margin-top:28px;color:#ffe4df}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:15px}article{background:#1c222a;border:1px solid #303a45;border-radius:18px;padding:21px;min-width:0}article.bad{border-color:#85504e}article.warn{border-color:#8c7844}
  article header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}h3{font-size:18px;margin:0 0 5px;overflow-wrap:anywhere}.container{font-size:12px;color:#91a0af;overflow-wrap:anywhere}
  .pill{white-space:nowrap;border-radius:100px;padding:5px 10px;font-size:12px}.good{background:#244c3b;color:#a5efbb}.bad-pill{background:#59312f;color:#ffc0b9}.warn-pill{background:#5b4825;color:#f5d88f}
  dl{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin:23px 0 20px}dt{font-size:12px;color:#91a0af}dd{margin:5px 0 0;font-size:14px;overflow-wrap:anywhere}
  .error{border-top:1px solid #303a45;padding-top:15px;display:flex;flex-wrap:wrap;gap:5px 10px;align-items:center;font-size:12px;color:#91a0af}.error b{color:#eaf0f6;font-size:13px}.error time{margin-left:auto}.error code{flex-basis:100%;color:#d5dfe9;overflow-wrap:anywhere}
  .service-link{display:inline-block;margin-top:15px;color:#d5f47a;font-size:13px;text-decoration:none}.service-link:hover{text-decoration:underline}
  #logs{scroll-margin-top:20px;border-top:1px solid #303a45;margin-top:42px;padding-top:8px}#logs h2{font-size:26px;margin-bottom:8px}
  form{display:flex;gap:10px;flex-wrap:wrap;align-items:end;background:#1c222a;border:1px solid #303a45;border-radius:16px;padding:18px;margin:24px 0 16px}
  label{display:flex;flex-direction:column;gap:6px;color:#9fb0c0;font-size:12px;font-weight:700}select,input{min-height:42px;background:#11171e;border:1px solid #3b4754;border-radius:9px;padding:0 11px;color:#eaf0f6;font:inherit;font-size:14px}
  input{min-width:220px;flex:1}button{min-height:42px;padding:0 16px;border:0;border-radius:11px;background:#d5f47a;color:#1c2a17;font:inherit;font-weight:700;cursor:pointer}.count{margin:0 0 12px;color:#9fb0c0;font-size:13px}.count b{color:#eaf0f6}
  .table-wrap{overflow:auto;border:1px solid #303a45;border-radius:15px;background:#1c222a}table{border-collapse:collapse;width:100%;min-width:760px}
  th{text-align:left;background:#242c35;color:#9fb0c0;font-size:12px;padding:12px 14px;position:sticky;top:0}td{vertical-align:top;border-top:1px solid #303a45;padding:12px 14px;font-size:13px}td.time{white-space:nowrap;color:#aab8c5}td.service{min-width:180px}
  .level{display:inline-block;border-radius:100px;padding:4px 8px;font-size:11px;font-weight:750;text-transform:uppercase}.level.error{background:#59312f;color:#ffc0b9}.level.warn{background:#5b4825;color:#f5d88f}.level.info{background:#244c3b;color:#a5efbb}
  td.message{min-width:320px;max-width:850px}td.message code{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.5;color:#d5dfe9}
  .pagination{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:17px;color:#9fb0c0;font-size:13px}.pagination a{color:#d5f47a;text-decoration:none}.pagination a:hover{text-decoration:underline}
  #log-results[aria-busy="true"]{opacity:.55;pointer-events:none}
  footer{margin-top:36px;color:#778898;font-size:12px}@media(max-width:600px){main{padding:27px 16px 48px}.metric{flex:1;min-width:135px}.grid{grid-template-columns:1fr}}
  </style></head><body><main>
  <header><div><span class="eyebrow">Сервер · все сервисы</span><h1>Состояние системы</h1>
    <p class="muted">Срез на ${escapeHtml(time(data?.checkedAt || new Date().toISOString()))} по Томску. Данные обновляются при открытии страницы.</p></div>
    <div class="actions"><a class="button secondary" href="#logs">Логи сервисов</a><a class="button" href="${PREFIX}">Обновить сейчас</a></div></header>
  ${problem ? `<div class="alert">Docker недоступен: ${escapeHtml(problem)}. Состояние сервисов неизвестно.</div>` : ''}
  <div class="summary"><div class="metric"><b>${services.length}</b><span>сервисов</span></div>
    <div class="metric"><b>${working}</b><span>работают</span></div>
    <div class="metric"><b>${services.length - working}</b><span>не работают</span></div>
    <div class="metric"><b>${warnings}</b><span>ошибки за час</span></div></div>
  ${sections || '<p class="muted" style="margin-top:30px">Контейнеры не найдены.</p>'}
  ${renderLogs(logs, logsProblem, services)}
  <footer>Источник: Docker на этом сервере. Одноразовые технические контейнеры скрыты. Контакты и секреты в журналах маскируются.</footer>
  </main><script>
  (() => {
    const form = document.getElementById('log-filters');
    const results = document.getElementById('log-results');
    const status = document.getElementById('selected-service-status');
    let pending;
    async function updateLogs() {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const params = new URLSearchParams(new FormData(form));
      params.delete('page');
      results.setAttribute('aria-busy', 'true');
      try {
        const response = await fetch('/server-status/api/logs?' + params, { signal: controller.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        results.innerHTML = await response.text();
        history.replaceState(null, '', '/server-status/?' + params + '#logs');
      } catch (error) {
        if (error.name !== 'AbortError') results.innerHTML = '<div class="alert">Не удалось загрузить журнал. Обновите страницу.</div>';
      } finally {
        if (!controller.signal.aborted) results.removeAttribute('aria-busy');
      }
    }
    form.addEventListener('change', (event) => {
      if (!event.target.matches('select')) return;
      if (event.target.name === 'service') {
        const option = event.target.selectedOptions[0];
        status.textContent = option.dataset.status || '';
        status.className = 'pill ' + (option.dataset.style || '');
        status.hidden = !option.dataset.status;
      }
      updateLogs();
    });
    form.addEventListener('submit', (event) => { event.preventDefault(); updateLogs(); });
  })();
  </script></body></html>`;
}

function renderLogResults(data, problem) {
  if (problem) return `<div class="alert">Не удалось прочитать журналы: ${escapeHtml(problem)}</div>`;
  const entries = data?.entries || [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const queryLink = (page) => {
    const params = new URLSearchParams({ service: data.service, since: data.period,
      level: data.level, q: data.search, page: String(page) });
    return PREFIX + '?' + params.toString() + '#logs';
  };
  return `<p class="count">Найдено: <b>${data?.total || 0}</b>. Показаны строки ${data?.total ? (data.page - 1) * data.limit + 1 : 0}–${data?.total ? Math.min(data.page * data.limit, data.total) : 0}.
    Источник: последние 500 строк каждого выбранного сервиса.</p>
  <div class="table-wrap"><table><thead><tr><th>Время · Томск</th><th>Сервис</th><th>Уровень</th><th>Сообщение</th></tr></thead>
    <tbody>${entries.map((entry) => `<tr><td class="time">${escapeHtml(time(entry.at))}</td>
      <td class="service">${escapeHtml(entry.service)}<div class="muted">${escapeHtml(entry.container)}</div></td>
      <td><span class="level ${entry.level}">${entry.level}</span></td>
      <td class="message"><code>${escapeHtml(entry.message)}</code></td></tr>`).join('') ||
      '<tr><td colspan="4" class="muted">По этим фильтрам записей нет</td></tr>'}</tbody></table></div>
  <div class="pagination"><span>Страница ${data?.page || 1} из ${pages}</span><span>
    ${data?.page > 1 ? `<a href="${escapeHtml(queryLink(data.page - 1))}">← Назад</a>` : ''}
    ${data?.page < pages ? `<a href="${escapeHtml(queryLink(data.page + 1))}">Вперёд →</a>` : ''}</span></div>`;
}

function renderLogs(data, problem, services = []) {
  const selected = (value, current) => value === current ? ' selected' : '';
  const serviceOptions = [['', 'Все сервисы'],
    ...(data?.available || [...EXPECTED.map(([name]) => name), SEVERBUS_REQUESTS])
      .map((name) => [name, NAMES[name] || name])];
  const periodOptions = [['1h', '1 час'], ['6h', '6 часов'], ['24h', '24 часа'],
    ['7d', '7 дней'], ['all', 'Весь доступный журнал']];
  const levelOptions = [['all', 'Все уровни'], ['error', 'Ошибки'],
    ['warn', 'Предупреждения'], ['info', 'Информация']];
  const currentService = services.find((service) => service.container === data?.service);
  const statusFor = (service) => service
    ? { label: healthy(service) ? (recentError(service) ? 'Есть ошибки' : 'Работает') : 'Проблема',
      style: healthy(service) ? (recentError(service) ? 'warn-pill' : 'good') : 'bad-pill' }
    : { label: '', style: '' };
  const currentStatus = statusFor(currentService);
  return `<section id="logs"><h2>Логи сервисов <span id="selected-service-status" class="pill ${currentStatus.style}"${currentService ? '' : ' hidden'}>${currentStatus.label}</span></h2>
    <p class="muted">Выберите сервис — его журнал появится здесь сразу. Состояние всех сервисов показано выше.</p>
    <form id="log-filters" action="${PREFIX}#logs" method="get">
      <label>Сервис<select name="service">${serviceOptions.map(([value, label]) => {
        const status = statusFor(services.find((service) => service.container === value));
        return `<option value="${escapeHtml(value)}" data-status="${status.label}" data-style="${status.style}"${selected(value, data?.service || '')}>${escapeHtml(label)}</option>`;
      }).join('')}</select></label>
      <label>Период<select name="since">${periodOptions.map(([value, label]) =>
        `<option value="${value}"${selected(value, data?.period || '24h')}>${label}</option>`).join('')}</select></label>
      <label>Уровень<select name="level">${levelOptions.map(([value, label]) =>
        `<option value="${value}"${selected(value, data?.level || 'all')}>${label}</option>`).join('')}</select></label>
      <label>Поиск<input name="q" value="${escapeHtml(data?.search || '')}" placeholder="Текст ошибки, URL, команда"></label>
      <button type="submit">Искать</button>
    </form>
    <div id="log-results" role="status" aria-live="polite">${renderLogResults(data, problem)}</div>
  </section>`;
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(req.url, 'http://status.local');
  const legacyLogs = url.pathname === '/server-status/logs/';
  const logsApi = url.pathname === '/server-status/api/logs';
  if (req.method !== 'GET' || (url.pathname !== PREFIX && !legacyLogs && !logsApi)) {
    return res.writeHead(404).end('Not found');
  }
  try {
    if (!authorized(req)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Server status", charset="UTF-8"');
      return res.writeHead(401).end('Требуется пароль');
    }
  } catch {
    return res.writeHead(503).end('Пароль страницы не настроен');
  }
  if (legacyLogs) {
    return res.writeHead(302, { Location: PREFIX + url.search + '#logs' }).end();
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (logsApi) {
    try {
      return res.end(renderLogResults(await logEntries(url.searchParams), null));
    } catch (error) {
      res.statusCode = 503;
      return res.end(renderLogResults(null, error.code || error.message || 'ошибка соединения'));
    }
  }
  const [statusResult, logsResult] = await Promise.allSettled([
    snapshot(), logEntries(url.searchParams),
  ]);
  const statusProblem = statusResult.status === 'rejected'
    ? statusResult.reason.code || statusResult.reason.message || 'ошибка соединения' : null;
  const logsProblem = logsResult.status === 'rejected'
    ? logsResult.reason.code || logsResult.reason.message || 'ошибка соединения' : null;
  if (statusProblem && logsProblem) res.statusCode = 503;
  res.end(render(statusResult.status === 'fulfilled' ? statusResult.value : null,
    logsResult.status === 'fulfilled' ? logsResult.value : null,
    statusProblem, logsProblem));
});

server.listen(PORT, '0.0.0.0', () => console.log('Server status listening on ' + PORT));

module.exports = { lastError, logText, healthy, render, renderLogs, renderLogResults,
  parseLogEntries, logLevel };
