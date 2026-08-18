#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Idempotent certificate guard — safe to run on every deploy.
#
# certbot renew (in the certbot container) handles healthy certificates every
# 12h. What it does NOT handle is a lineage it refuses to touch at all: if
# live/<name>/*.pem are regular files instead of symlinks, renew skips that one
# certificate silently, and it quietly expires while every other cert on the
# box keeps renewing. That is how slotik.tech died for two months.
#
# This script closes that gap. For each lineage in certs.list it decides whether
# a re-issue is actually needed and only then calls fix-cert.sh. On a healthy
# server it makes no network calls to Let's Encrypt at all, so it cannot burn
# rate limits by running on every push.
#
# Usage:
#   bash scripts/ensure-certs.sh          # check, repair what is broken
#   CHECK_ONLY=1 bash scripts/ensure-certs.sh   # report only, never re-issue
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

MANIFEST="${ROOT_DIR}/certs.list"
CONF_DIR="${ROOT_DIR}/certbot/conf"
CHECK_ONLY="${CHECK_ONLY:-0}"

if [ ! -f "$MANIFEST" ]; then
  echo "!! ${MANIFEST} not found" >&2
  exit 1
fi

REPAIRED=()
FAILED=()
HEALTHY=()

# Manifest is read on fd 3: fix-cert.sh runs `docker compose exec`, which
# forwards stdin and would otherwise swallow the remaining lines.
while read -r line <&3; do
  # Skip comments and blank lines.
  case "$line" in ''|\#*) continue ;; esac

  # shellcheck disable=SC2206
  domains=($line)
  name="${domains[0]}"
  reason=""

  # 1. Is the lineage present and laid out the way certbot expects?
  if [ ! -e "${CONF_DIR}/live/${name}/cert.pem" ]; then
    reason="no certificate on disk"
  elif [ ! -L "${CONF_DIR}/live/${name}/cert.pem" ]; then
    reason="live/${name}/cert.pem is a regular file, not a symlink — certbot renew skips this lineage"
  else
    # 2. Does every hostname actually serve a cert a browser accepts?
    #    This catches both expiry and a hostname missing from the SAN list.
    for d in "${domains[@]}"; do
      rc=0
      curl -sS --max-time 15 -o /dev/null "https://${d}/" >/dev/null 2>&1 </dev/null || rc=$?
      [ "$rc" -eq 0 ] && continue
      case "$rc" in
        60|51|58|59|35)
          reason="https://${d} fails TLS verification (curl ${rc})"
          break
          ;;
        *) : ;;  # connection/HTTP problem, not a cert problem — not our business
      esac
    done
  fi

  if [ -z "$reason" ]; then
    printf '  %-16s OK\n' "$name"
    HEALTHY+=("$name")
    continue
  fi

  printf '  %-16s NEEDS RE-ISSUE: %s\n' "$name" "$reason"

  if [ "$CHECK_ONLY" = "1" ]; then
    FAILED+=("$name")
    continue
  fi

  echo "  ---- running fix-cert.sh ${domains[*]} ----"
  if bash "${SCRIPT_DIR}/fix-cert.sh" "${domains[@]}" </dev/null; then
    REPAIRED+=("$name")
  else
    echo "  !! fix-cert.sh failed for ${name}" >&2
    FAILED+=("$name")
  fi
done 3< "$MANIFEST"

echo
echo "==> Certificates: ${#HEALTHY[@]} healthy, ${#REPAIRED[@]} repaired, ${#FAILED[@]} failed"

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "!! Still broken: ${FAILED[*]}" >&2
  exit 1
fi
