# Reverse Proxy — Контекст проекта

## Что это

Общий reverse-proxy для всех личных проектов на одном VDS. Один nginx принимает весь трафик (80/443), маршрутизирует по домену на нужный бэкенд. Один certbot управляет SSL-сертификатами для всех доменов.

**Сервер:** VDS (тот же, где стоит reservation-service)
**Проекты на сервере:** severbus.ru, slotik.tech

## Зачем отдельная репа

Раньше nginx + certbot жили внутри reservation-service. Когда появился второй проект (severbus), стало понятно что:
- Два nginx на одном сервере — конфликт за порты 80/443
- SSL-сертификаты в двух местах — неудобно
- Добавлять третий проект — лезть в чужой docker-compose

Выделенный reverse-proxy решает все три проблемы. Каждый проект поднимает только свой бэкенд, а reverse-proxy берёт на себя маршрутизацию, SSL и отдачу статики.

## Архитектура

```
VDS
│
├── /opt/reverse-proxy/              ← эта репа
│   ├── docker-compose.yml           ← nginx + certbot
│   ├── nginx/conf.d/                ← HTTPS-конфиги по домену
│   └── certbot/                     ← сертификаты (gitignored)
│
├── /opt/severbus/                   ← bus-schedule
│   ├── docker-compose.yml           ← только backend
│   ├── frontend-dist/               ← собранный фронтенд (volume)
│   └── data/                        ← SQLite
│
└── /opt/reservation-service/        ← reservation-service
    ├── docker-compose.yml           ← только backend
    ├── frontend-dist/               ← собранный фронтенд (volume)
    ├── admin-dist/                  ← собранная админка (volume)
    ├── landing/dist/                ← лендинг (volume)
    └── data/                        ← SQLite
```

### Docker network

Все compose-проекты подключены к общей external network `shared-proxy`. Создаётся один раз: `docker network create shared-proxy`.

```
shared-proxy network
├── reverse-proxy-nginx        → слушает 80/443, маршрутизирует
├── reverse-proxy-certbot      → auto-renew каждые 12ч
├── severbus-backend           → expose 3000
└── reservation-backend        → expose 3000
```

Reverse-proxy nginx обращается к бэкендам по имени контейнера (например, `proxy_pass http://severbus-backend:3000`).

### Как nginx находит фронтенды

Статика фронтендов не проходит через бэкенды. nginx отдаёт её напрямую из volumes:

```yaml
# docker-compose.yml reverse-proxy
volumes:
  - /opt/severbus/frontend-dist:/var/www/severbus:ro
  - /opt/reservation-service/frontend-dist:/var/www/slotik:ro
  - ...
```

В nginx: `root /var/www/severbus` + `try_files $uri $uri/ /index.html` (SPA fallback).

## Стек

- **nginx:alpine** — reverse-proxy, TLS termination, static serving
- **certbot/certbot** — Let's Encrypt, auto-renewal

## Структура файлов

```
reverse-proxy/
├── docker-compose.yml
├── nginx/
│   ├── conf.d/                 ← production конфиги (HTTPS + HTTP→HTTPS redirect)
│   │   ├── severbus.conf       ← severbus.ru
│   │   └── slotik.conf         ← slotik.tech + admin.slotik.tech
│   └── conf.d-init/            ← HTTP-only (для первичного получения SSL)
│       ├── severbus.conf
│       └── slotik.conf
├── scripts/
│   ├── init-letsencrypt.sh     ← первый запуск: получить SSL с нуля
│   └── add-domain.sh           ← добавить домен к работающему proxy
├── certbot/                    ← (gitignored) сертификаты Let's Encrypt
├── context.md                  ← этот файл
├── .gitignore
└── README.md
```

### conf.d vs conf.d-init

- `conf.d/` — основные конфиги. Содержат HTTPS server blocks с путями к сертификатам. Используются в обычной работе.
- `conf.d-init/` — HTTP-only версии тех же конфигов. Без SSL. Используются скриптом `init-letsencrypt.sh` при первом запуске, когда сертификатов ещё нет — чтобы nginx мог стартовать и отвечать на ACME challenge.

## Как работать

### Добавить новый проект

1. В проекте создать `docker-compose.yml` с бэкендом в `shared-proxy` network:
   ```yaml
   networks:
     shared-proxy:
       external: true
   services:
     backend:
       container_name: <project>-backend
       networks:
         - shared-proxy
   ```
2. Здесь добавить `nginx/conf.d/<domain>.conf` (HTTPS) и `nginx/conf.d-init/<domain>.conf` (HTTP)
3. В `docker-compose.yml` добавить volume для статики нового проекта
4. Задеплоить, получить SSL: `bash scripts/add-domain.sh <domain>`

### Обновить nginx-конфиг

Отредактировать файл в `nginx/conf.d/`, затем:
```bash
docker-compose exec nginx nginx -t          # проверить синтаксис
docker-compose exec nginx nginx -s reload   # применить без даунтайма
```

### Отладка

```bash
docker-compose logs -f nginx                # логи nginx
docker-compose logs -f certbot              # логи certbot
docker-compose exec nginx nginx -T          # дамп всей конфигурации
```

### Рестарт

```bash
docker-compose restart nginx    # перезапуск nginx
docker-compose up -d            # перезапуск всего
```

## Деплой

Автоматический через GitHub Actions. При пуше в `main` (или ручном запуске workflow):

1. `rsync` файлов на сервер в `/opt/reverse-proxy` (исключая `certbot/`, `.git`)
2. `docker-compose up -d` — пересоздаёт контейнеры если compose изменился
3. `nginx -t` — проверка синтаксиса конфига (если битый — workflow падает)
4. `nginx -s reload` — применяет конфиги без даунтайма
5. Health check на `severbus.ru` и `slotik.tech`

**Секреты GitHub:** `SSH_PRIVATE_KEY`, `DEPLOY_HOST`, `DEPLOY_USER` — те же что в bus-schedule и reservation-service.

## Связанные проекты

| Проект | Репа | Что делает |
|--------|------|------------|
| bus-schedule | `ndrwbv/bus-schedule` (GitHub, personal) | severbus.ru — расписание автобусов |
| reservation-service | `Atlantis3221/reservation-service` (GitHub, personal) | slotik.tech — бронирование |
