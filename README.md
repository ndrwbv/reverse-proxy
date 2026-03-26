# Reverse Proxy

Общий nginx + certbot для всех проектов на VDS. Маршрутизирует по домену, управляет SSL-сертификатами.

## Проекты

| Домен | Проект | Путь на сервере |
|-------|--------|-----------------|
| `severbus.ru` | bus-schedule | `/opt/severbus` |
| `slotik.tech` | reservation-service | `/opt/reservation-service` |
| `admin.slotik.tech` | reservation-service (admin) | `/opt/reservation-service` |

## Архитектура

```
shared-proxy (docker network)
├── reverse-proxy-nginx      → 80/443, маршрутизация по домену
├── reverse-proxy-certbot    → auto-renewal каждые 12ч
├── severbus-backend         → expose 3000
└── reservation-backend      → expose 3000
```

Каждый проект — отдельный `docker-compose.yml` со своим бэкендом, подключённым к `shared-proxy` network. Reverse-proxy видит бэкенды по имени контейнера.

Фронтенды — собранная статика в `frontend-dist/`, подмонтированная в nginx как volume.

## Первоначальная настройка

```bash
# 1. Создать shared network (один раз)
docker network create shared-proxy

# 2. Склонировать на сервер
cd /opt
git clone git@github-personal:ndrwbv/reverse-proxy.git

# 3. Скопировать сертификаты из reservation-service (если уже есть)
cp -r /opt/reservation-service/certbot/conf /opt/reverse-proxy/certbot/conf

# 4. Запустить
cd /opt/reverse-proxy
docker-compose up -d
```

## Получение SSL для нового домена

Если сертификата ещё нет (например, добавляем `severbus.ru`):

```bash
# DNS должен уже указывать на этот сервер
cd /opt/reverse-proxy
bash scripts/init-letsencrypt.sh severbus.ru

# Или для теста (staging, без rate limits):
STAGING=1 bash scripts/init-letsencrypt.sh severbus.ru
```

Если reverse-proxy уже работает и нужно просто добавить домен:

```bash
bash scripts/add-domain.sh severbus.ru
```

## Добавление нового проекта

1. В проекте: `docker-compose.yml` с бэкендом в `shared-proxy` network (без nginx/certbot)
2. Здесь: добавить `nginx/conf.d/<domain>.conf` и `nginx/conf.d-init/<domain>.conf`
3. В `docker-compose.yml`: добавить volume для статики нового проекта
4. `docker-compose up -d` (или `docker-compose exec nginx nginx -s reload`)
5. `bash scripts/add-domain.sh <domain>` — получить SSL

## Деплой

Автоматический через GitHub Actions — при пуше в `main` или ручном запуске workflow.

Workflow (`deploy.yml`) делает:
1. `rsync` файлов на сервер (исключая `certbot/`, `.git`)
2. `docker-compose up -d`
3. `nginx -t` — проверка конфига (если невалидный — workflow падает)
4. `nginx -s reload` — применение без даунтайма
5. Health check на оба домена

### Необходимые секреты GitHub

| Секрет | Описание |
|--------|----------|
| `SSH_PRIVATE_KEY` | SSH-ключ для доступа на сервер |
| `DEPLOY_HOST` | IP или хостнейм VDS |
| `DEPLOY_USER` | Пользователь SSH (обычно `root`) |

Те же секреты используются в bus-schedule и reservation-service.

## Структура

```
reverse-proxy/
├── .github/
│   └── workflows/
│       └── deploy.yml             ← CI/CD: rsync + reload nginx
├── docker-compose.yml             ← nginx + certbot
├── nginx/
│   ├── conf.d/                    ← production конфиги (HTTPS)
│   │   ├── severbus.conf
│   │   └── slotik.conf
│   └── conf.d-init/               ← HTTP-only (для первичного получения SSL)
│       ├── severbus.conf
│       └── slotik.conf
├── scripts/
│   ├── init-letsencrypt.sh        ← первичная настройка SSL (с нуля)
│   └── add-domain.sh              ← добавить домен к работающему reverse-proxy
├── specs/                         ← спецификации
├── certbot/                       ← (gitignored) сертификаты + webroot
├── .gitignore
└── README.md
```

## Обслуживание

- **Сертификаты** обновляются автоматически (certbot renew каждые 12ч)
- **Добавить домен** — новый `.conf` + `add-domain.sh`
- **Перезагрузить nginx** — `docker-compose exec nginx nginx -s reload`
- **Логи nginx** — `docker-compose logs -f nginx`
- **Проверить конфиг** — `docker-compose exec nginx nginx -t`
