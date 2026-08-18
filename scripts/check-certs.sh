#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Проверка, что автопродление сертификатов действительно работает.
#
# Ничего не меняет — только проверяет. Падает с ненулевым кодом, если что-то не
# так, чтобы GitHub прислал письмо о упавшем workflow: именно молчание привело
# к тому, что slotik.tech простоял с истёкшим сертификатом два месяца.
#
# Usage:
#   bash scripts/check-certs.sh
#   MIN_DAYS=30 bash scripts/check-certs.sh   # порог предупреждения
###############################################################################

MIN_DAYS="${MIN_DAYS:-21}"
CERTBOT_TIMEOUT="${CERTBOT_TIMEOUT:-420}"
LOCK_TRIES="${LOCK_TRIES:-5}"
LOCK_DELAY="${LOCK_DELAY:-30}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

CONF_DIR="${ROOT_DIR}/certbot/conf"
WWW_DIR="${ROOT_DIR}/certbot/www"
FAILED=0

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

# Вывод в файл, а не в пайп: через `| sed` он буферизуется, SSH-сессия висит в
# тишине и рвётся по idle-таймауту раньше, чем certbot закончит.
run_certbot() {
  timeout "$CERTBOT_TIMEOUT" docker run --rm \
    -v "${CONF_DIR}:/etc/letsencrypt" \
    -v "${WWW_DIR}:/var/www/certbot" \
    certbot/certbot "$@" >"$LOG" 2>&1
}

# Контейнер certbot из docker-compose гоняет `certbot renew` при старте и каждые
# 12 ч. Пока он держит лок на /etc/letsencrypt, второй certbot падает с
# "Another instance of Certbot is already running" — это не поломка продления,
# а совпадение по времени (например, деплой только что поднял контейнер).
# Поэтому такой ответ ретраим, а не считаем ошибкой.
attempt_certbot() {
  local i rc=0
  for ((i = 1; i <= LOCK_TRIES; i++)); do
    set +e
    run_certbot "$@"
    rc=$?
    set -e
    if grep -qi "Another instance of Certbot is already running" "$LOG"; then
      if [ "$i" -lt "$LOCK_TRIES" ]; then
        echo "    лок certbot занят (попытка ${i}/${LOCK_TRIES}) — ждём ${LOCK_DELAY}с"
        sleep "$LOCK_DELAY"
        continue
      fi
      echo "!!  лок certbot занят все ${LOCK_TRIES} попыток" >&2
    fi
    return $rc
  done
  return $rc
}

###############################################################################
# 1. Настоящий прогон продления против staging-сервера Let's Encrypt.
#    Единственная честная проверка: certbot реально проходит HTTP-01 по каждому
#    домену и валидирует renewal-конфиги. Ничего не перезаписывает и не
#    расходует лимиты продакшн-CA.
###############################################################################
echo "==> certbot renew --dry-run (может занять несколько минут)"
set +e
attempt_certbot renew --dry-run
DRY_RC=$?
set -e
sed 's/^/    /' "$LOG"

if [ "$DRY_RC" -eq 0 ]; then
  echo "    OK: продление проходит"
elif [ "$DRY_RC" -eq 124 ]; then
  echo "!!  dry-run не завершился за ${CERTBOT_TIMEOUT} с" >&2
  FAILED=1
else
  echo "!!  certbot renew --dry-run упал (код ${DRY_RC}) — автопродление НЕ работает" >&2
  FAILED=1
fi
echo

###############################################################################
# 2. Сколько дней осталось у каждого сертификата. Ловит случай, когда renew
#    формально не падает, но сертификат не обновляется и идёт к истечению.
###############################################################################
echo "==> Сроки действия (порог ${MIN_DAYS} дн.)"
set +e
attempt_certbot certificates
set -e
CERT_OUTPUT="$(cat "$LOG")"

CURRENT=""
FOUND_ANY=0
while IFS= read -r line; do
  case "$line" in
    *"Certificate Name:"*)
      CURRENT="${line##*Certificate Name: }"
      ;;
    *"Expiry Date:"*)
      FOUND_ANY=1
      if [[ "$line" =~ VALID:\ ([0-9]+)\ day ]]; then
        days="${BASH_REMATCH[1]}"
        if [ "$days" -lt "$MIN_DAYS" ]; then
          printf '!!  %-16s осталось %s дн. — меньше порога\n' "$CURRENT" "$days" >&2
          FAILED=1
        else
          printf '    %-16s осталось %s дн.\n' "$CURRENT" "$days"
        fi
      else
        printf '!!  %-16s недействителен: %s\n' "$CURRENT" "${line##*Expiry Date: }" >&2
        FAILED=1
      fi
      ;;
  esac
done <<< "$CERT_OUTPUT"

if [ "$FOUND_ANY" -eq 0 ]; then
  echo "!!  certbot не нашёл ни одного сертификата" >&2
  sed 's/^/    /' "$LOG"
  FAILED=1
fi
echo

###############################################################################
# 3. Раскладка на диске и то, что реально отдаётся по HTTPS каждому хосту.
###############################################################################
echo "==> Раскладка и HTTPS по всем хостам из certs.list"
set +e
CHECK_ONLY=1 bash "${SCRIPT_DIR}/ensure-certs.sh"
ENSURE_RC=$?
set -e
[ "$ENSURE_RC" -eq 0 ] || FAILED=1
echo

if [ "$FAILED" -ne 0 ]; then
  echo "==> ПРОВЕРКА НЕ ПРОЙДЕНА — см. сообщения выше" >&2
  exit 1
fi
echo "==> Всё в порядке: автопродление работает, сроки в норме"
