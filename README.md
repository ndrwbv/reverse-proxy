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
#    ВАЖНО: именно `cp -a` и именно с `/.` в конце источника.
#    `cp -r` разыменовывает симлинки в live/<домен>/ и превращает их в обычные
#    файлы — после этого `certbot renew` молча пропускает этот сертификат,
#    и он тихо доживает до истечения. Если это уже случилось —
#    `bash scripts/fix-cert.sh <домен> ...` перевыпустит его правильно.
mkdir -p /opt/reverse-proxy/certbot/conf
cp -a /opt/reservation-service/certbot/conf/. /opt/reverse-proxy/certbot/conf/

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

## Какие домены в каком сертификате

`certs.list` — единственный источник правды. Одна строка на сертификат, первый
домен даёт имя lineage (и путь `/etc/letsencrypt/live/<домен>/` в конфигах nginx),
остальные попадают в SAN.

**Каждый хост, для которого nginx терминирует TLS, обязан быть в этом файле.**
Если 443-блок для хоста есть, а в сертификате его нет — браузер отдаёт
`no alternative certificate subject name matches`. Так и было с `www.severbus.ru`
и `www.slotik.tech`: блоки с редиректом на apex добавили, а в сертификаты `www`
не включили.

## Сертификат истёк, хотя certbot работает

Симптом: один домен отдаёт «certificate has expired», а остальные на этом же
сервере обновляются нормально. Значит `certbot renew` падает именно на этой
lineage — чаще всего потому, что `live/<домен>/*.pem` это обычные файлы, а не
симлинки (следствие `cp -r`, см. выше).

```bash
cd /opt/reverse-proxy
bash scripts/fix-cert.sh slotik.tech www.slotik.tech admin.slotik.tech
```

Скрипт: проверяет доступность ACME-challenge по каждому домену до обращения к
Let's Encrypt, откладывает битую lineage в `certbot/conf/broken-lineage-backup/`,
перевыпускает сертификат под тем же `--cert-name` (пути в nginx не меняются),
проверяет, что симлинки восстановлены, и перезагружает nginx.

Первый домен в списке — имя lineage. Все остальные попадут в SAN, поэтому
перечислять надо **все** хосты, которые терминируются этим сертификатом,
включая `www`. Для проверки без расхода лимитов: `STAGING=1 bash scripts/fix-cert.sh ...`

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
5. `scripts/ensure-certs.sh` — перевыпускает только те сертификаты, что реально
   сломаны (истёк / нет нужного хоста в SAN / `live/*.pem` не симлинки). На
   здоровом сервере не обращается к Let's Encrypt вообще, поэтому безопасно
   гонять на каждом пуше и лимиты не расходуются
6. Health check по HTTPS **как браузер**, без `-k`, и **валит workflow** при
   любой ошибке. Раньше проверки заканчивались на `|| echo` — именно поэтому
   истёкший сертификат никто не замечал два месяца, а `severbus.ru/health`,
   который отдаёт 404, не замечали вообще

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
│   ├── add-domain.sh              ← добавить домен к работающему reverse-proxy
│   ├── fix-cert.sh                ← перевыпустить сертификат со сломанным renew
│   ├── ensure-certs.sh            ← проверить/починить все сертификаты (в деплое)
│   └── check-certs.sh             ← проверить, что автопродление реально работает
├── certs.list                     ← какие домены в каком сертификате
├── specs/                         ← спецификации
├── certbot/                       ← (gitignored) сертификаты + webroot
├── .gitignore
└── README.md
```

## Обслуживание

- **Сертификаты** обновляются автоматически (certbot renew каждые 12ч), nginx
  перечитывает их раз в 6ч (reload-цикл в `command:` сервиса nginx). Renewal
  падает молча, поэтому стоит иногда проверять срок:
  `curl -sSI https://slotik.tech >/dev/null` или
  `docker-compose run --rm --entrypoint certbot certbot certificates`
- **Сертификат истёк** — `bash scripts/fix-cert.sh <домен> [ещё домены]`
- **Проверить автопродление** — `bash scripts/check-certs.sh`. Гоняет
  `certbot renew --dry-run` (реальный HTTP-01 против staging-CA, ничего не
  перезаписывает и не тратит лимиты), проверяет остаток дней и раскладку.
  Запускается на каждом деплое и по расписанию — workflow `cert-check.yml`,
  каждый понедельник. Если проверка падает, GitHub присылает письмо; это
  единственный способ узнать о поломке, не дожидаясь падения сайта.
- **Добавить домен** — новый `.conf` + `add-domain.sh`
- **Перезагрузить nginx** — `docker-compose exec nginx nginx -s reload`
- **Логи nginx** — `docker-compose logs -f nginx`
- **Проверить конфиг** — `docker-compose exec nginx nginx -t`
