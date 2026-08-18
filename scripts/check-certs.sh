#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Проверка, что автопродление сертификатов действительно работает.
#
# Ничего не меняет — только проверяет. Запускается из деплоя и по расписанию
# (.github/workflows/cert-check.yml). Падает с ненулевым кодом, если что-то не
# так, чтобы GitHub прислал письмо о упавшем workflow: именно молчание привело
# к тому, что slotik.tech простоял с истёкшим сертификатом два месяца.
#
# Usage:
#   bash scripts/check-certs.sh
#   MIN_DAYS=30 bash scripts/check-certs.sh   # порог предупреждения
###############################################################################

MIN_DAYS="${MIN_DAYS:-21}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

CONF_DIR="${ROOT_DIR}/certbot/conf"
WWW_DIR="${ROOT_DIR}/certbot/www"
FAILED=0

###############################################################################
# 1. Настоящий прогон продления против staging-сервера Let's Encrypt.
#    Это единственная честная проверка: certbot реально проходит HTTP-01 по
#    каждому домену и валидирует renewal-конфиги. Ничего не перезаписывает и
#    не расходует лимиты продакшн-CA.
###############################################################################
echo "==> certbot renew --dry-run (может занять несколько минут)"
DRY_LOG="$(mktemp)"
trap 'rm -f "$DRY_LOG"' EXIT

# Вывод в файл, а не в пайп: через `| sed` он буферизуется, SSH-сессия висит в
# тишине и рвётся по idle-таймауту раньше, чем certbot закончит.
# timeout — чтобы зависший запуск падал внятно, а не через полчаса.
set +e
timeout 420 docker run --rm \
  -v "${CONF_DIR}:/etc/letsencrypt" \
  -v "${WWW_DIR}:/var/www/certbot" \
  certbot/certbot renew --dry-run >"$DRY_LOG" 2>&1
DRY_RC=$?
set -e

sed 's/^/    /' "$DRY_LOG"

if [ "$DRY_RC" -eq 0 ]; then
  echo "    OK: продление проходит"
elif [ "$DRY_RC" -eq 124 ]; then
  echo "!!  dry-run не завершился за 420 с" >&2
  FAILED=1
else
  echo "!!  certbot renew --dry-run упал (код ${DRY_RC}) — автопродление НЕ работает" >&2
  FAILED=1
fi
echo

###############################################################################
# 2. Сколько дней осталось у каждого сертификата.
#    Ловит случай, когда renew формально не падает, но сертификат почему-то не
#    обновляется и тихо идёт к истечению.
###############################################################################
echo "==> Сроки действия (порог ${MIN_DAYS} дн.)"
CERT_OUTPUT="$(docker run --rm \
  -v "${CONF_DIR}:/etc/letsencrypt" \
  certbot/certbot certificates 2>/dev/null || true)"

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
  FAILED=1
fi
echo

###############################################################################
# 3. Раскладка на диске и то, что реально отдаётся по HTTPS каждому хосту.
###############################################################################
echo "==> Раскладка и HTTPS по всем хостам из certs.list"
if CHECK_ONLY=1 bash "${SCRIPT_DIR}/ensure-certs.sh"; then
  :
else
  FAILED=1
fi
echo

if [ "$FAILED" -ne 0 ]; then
  echo "==> ПРОВЕРКА НЕ ПРОЙДЕНА — см. сообщения выше" >&2
  exit 1
fi
echo "==> Всё в порядке: автопродление работает, сроки в норме"
