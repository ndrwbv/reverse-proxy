#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Re-issue an SSL certificate whose auto-renewal is broken.
#
# Use this when a cert expired even though the certbot container is running.
# The usual cause on this server: the lineage in certbot/conf was seeded with
# `cp -r` (see README "Первоначальная настройка", step 3). Plain `cp -r`
# dereferences the live/<name>/*.pem symlinks into regular files, and
# `certbot renew` then refuses to touch that lineage — silently, per-cert,
# while every other cert on the box keeps renewing fine.
#
# Usage (on the server):
#   cd /opt/reverse-proxy
#   bash scripts/fix-cert.sh slotik.tech www.slotik.tech admin.slotik.tech
#   bash scripts/fix-cert.sh severbus.ru www.severbus.ru
#
# The FIRST domain is the lineage name (--cert-name), so the paths already
# baked into nginx/conf.d/*.conf (/etc/letsencrypt/live/<first>/) keep working.
# Every domain listed must be in the cert, or nginx will serve a name mismatch
# for the ones that are missing.
#
# Env:
#   STAGING=1   use the Let's Encrypt staging CA (untrusted, no rate limits)
#   EMAIL=...   registration email (default: admin@<first-domain>)
###############################################################################

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <primary-domain> [extra-domain ...]" >&2
  exit 1
fi

CERT_NAME="$1"
DOMAINS=("$@")
EMAIL="${EMAIL:-admin@${CERT_NAME}}"
STAGING="${STAGING:-0}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

CONF_DIR="$ROOT_DIR/certbot/conf"
WWW_DIR="$ROOT_DIR/certbot/www"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
else
  DC="docker-compose"
fi

CERTBOT_IMAGE="certbot/certbot"

# Run a certbot subcommand against the live config dir.
# Uses certbot's own `certificates` command rather than openssl, because the
# certbot image is not guaranteed to ship an openssl CLI.
certbot_show() {
  docker run --rm \
    -v "${CONF_DIR}:/etc/letsencrypt" \
    -v "${WWW_DIR}:/var/www/certbot" \
    "$CERTBOT_IMAGE" certificates --cert-name "$1"
}

echo "==> Re-issuing certificate '${CERT_NAME}' for: ${DOMAINS[*]}"
echo

###############################################################################
# 1. Show what is on disk right now
###############################################################################
echo "==> Current certificate on disk"
if [ -e "${CONF_DIR}/live/${CERT_NAME}/cert.pem" ]; then
  certbot_show "$CERT_NAME" 2>/dev/null || echo "    (certbot could not read this lineage)"
  if [ -L "${CONF_DIR}/live/${CERT_NAME}/cert.pem" ]; then
    echo "    live/${CERT_NAME}/cert.pem: symlink (healthy layout)"
    LINEAGE_BROKEN=0
  else
    echo "    live/${CERT_NAME}/cert.pem: REGULAR FILE — expected a symlink."
    echo "    This is why 'certbot renew' skips this lineage. Rebuilding it."
    LINEAGE_BROKEN=1
  fi
else
  echo "    (no certificate found for ${CERT_NAME})"
  LINEAGE_BROKEN=0
fi
echo

###############################################################################
# 2. Pre-flight: prove the ACME HTTP-01 path really works for every domain
#    Cheaper to fail here than to burn a Let's Encrypt attempt.
###############################################################################
echo "==> Pre-flight: checking /.well-known/acme-challenge/ for each domain"
TOKEN="preflight-$$"
mkdir -p "${WWW_DIR}/.well-known/acme-challenge"
echo "$TOKEN" > "${WWW_DIR}/.well-known/acme-challenge/${TOKEN}"
cleanup_token() { rm -f "${WWW_DIR}/.well-known/acme-challenge/${TOKEN}"; }
trap cleanup_token EXIT

PREFLIGHT_FAILED=0
for d in "${DOMAINS[@]}"; do
  url="http://${d}/.well-known/acme-challenge/${TOKEN}"
  code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
  body="$(curl -sS --max-time 15 "$url" 2>/dev/null || true)"
  if [ "$body" = "$TOKEN" ]; then
    printf '    %-26s OK (http %s)\n' "$d" "$code"
  else
    case "$code" in
      301|302) reason="redirected — the ACME location is being sent to HTTPS" ;;
      404)     reason="reached nginx, but webroot did not serve the token" ;;
      000)     reason="could not connect (DNS or firewall)" ;;
      *)       reason="unexpected response" ;;
    esac
    printf '    %-26s FAILED (http %s: %s)\n' "$d" "$code" "$reason"
    PREFLIGHT_FAILED=1
  fi
done

if [ "$PREFLIGHT_FAILED" -ne 0 ]; then
  echo
  echo "!! At least one domain cannot serve the ACME challenge." >&2
  echo "   Check that its DNS A record points at this server and that its" >&2
  echo "   port-80 server block in nginx/conf.d/ has:" >&2
  echo "     location /.well-known/acme-challenge/ { root /var/www/certbot; }" >&2
  echo "   Fix that first — Let's Encrypt would fail the same way." >&2
  exit 1
fi
cleanup_token
trap - EXIT
echo

###############################################################################
# 3. Move a corrupted lineage out of the way so certbot can rebuild it
###############################################################################
LINEAGE_PARTS=("live/${CERT_NAME}" "archive/${CERT_NAME}" "renewal/${CERT_NAME}.conf")
BACKUP_DIR="${CONF_DIR}/broken-lineage-backup/${CERT_NAME}"
MOVED_TO_BACKUP=0

# If the re-issue fails after we moved the old lineage away, put it back.
# An expired cert still lets nginx start; missing cert files do not, and that
# would take the whole server down on the next `nginx -t`.
restore_lineage() {
  [ "$MOVED_TO_BACKUP" -eq 1 ] || return 0
  echo >&2
  echo "!! Re-issue did not complete — restoring the previous lineage." >&2
  for p in "${LINEAGE_PARTS[@]}"; do
    if [ -e "${BACKUP_DIR}/${p}" ]; then
      rm -rf "${CONF_DIR}/${p}"
      mkdir -p "$(dirname "${CONF_DIR}/${p}")"
      mv "${BACKUP_DIR}/${p}" "${CONF_DIR}/${p}"
      echo "   restored ${p}" >&2
    fi
  done
  echo "   The certificate is still broken, but nginx will start as before." >&2
}

if [ "$LINEAGE_BROKEN" -eq 1 ]; then
  echo "==> Backing up broken lineage to ${BACKUP_DIR}"
  mkdir -p "$BACKUP_DIR"
  for p in "${LINEAGE_PARTS[@]}"; do
    if [ -e "${CONF_DIR}/${p}" ]; then
      mkdir -p "$(dirname "${BACKUP_DIR}/${p}")"
      rm -rf "${BACKUP_DIR}/${p}"
      mv "${CONF_DIR}/${p}" "${BACKUP_DIR}/${p}"
      echo "    moved ${p}"
    fi
  done
  MOVED_TO_BACKUP=1
  trap restore_lineage EXIT
  echo "    (accounts/ left untouched — the ACME account is still valid)"
  echo
fi

###############################################################################
# 4. Request the certificate
###############################################################################
STAGING_FLAG=""
if [ "$STAGING" -eq 1 ]; then
  STAGING_FLAG="--staging"
  echo "==> Using STAGING CA — the resulting cert will NOT be trusted by browsers"
fi

D_FLAGS=()
for d in "${DOMAINS[@]}"; do
  D_FLAGS+=(-d "$d")
done

echo "==> Requesting certificate from Let's Encrypt..."
docker run --rm \
  -v "${CONF_DIR}:/etc/letsencrypt" \
  -v "${WWW_DIR}:/var/www/certbot" \
  "$CERTBOT_IMAGE" certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --cert-name "$CERT_NAME" \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  --non-interactive \
  --expand \
  --force-renewal \
  "${D_FLAGS[@]}" \
  $STAGING_FLAG
echo

###############################################################################
# 5. Verify the new cert on disk, including the symlink layout
###############################################################################
echo "==> New certificate on disk"
certbot_show "$CERT_NAME"
if [ -L "${CONF_DIR}/live/${CERT_NAME}/cert.pem" ]; then
  echo "    live/${CERT_NAME}/cert.pem: symlink — auto-renewal will work"
else
  echo "!! live/${CERT_NAME}/cert.pem is still not a symlink — renewal will break again" >&2
  exit 1
fi

# New cert is on disk and correctly linked — the old lineage is no longer needed.
MOVED_TO_BACKUP=0
trap - EXIT
echo

###############################################################################
# 6. Reload nginx
###############################################################################
echo "==> Validating and reloading nginx"
$DC exec -T nginx nginx -t
$DC exec -T nginx nginx -s reload
echo

###############################################################################
# 7. Confirm over the wire
###############################################################################
echo "==> Verifying over HTTPS"
FAILED=0
for d in "${DOMAINS[@]}"; do
  out="$(curl -sS --max-time 20 -o /dev/null \
    -w 'code=%{http_code} tls_verify=%{ssl_verify_result}' "https://${d}/" 2>&1 || true)"
  case "$out" in
    *tls_verify=0*) printf '    %-26s %s\n' "$d" "$out" ;;
    *)              printf '    %-26s %s\n' "$d" "$out"; FAILED=1 ;;
  esac
done
echo

if [ "$FAILED" -ne 0 ]; then
  if [ "$STAGING" -eq 1 ]; then
    echo "==> TLS verification failed, which is expected with STAGING=1."
    echo "    Re-run without STAGING=1 to issue the real certificate."
  else
    echo "!! Some domains still fail TLS verification — see above." >&2
    exit 1
  fi
else
  echo "==> Done. Certificate for '${CERT_NAME}' is live and renewable."
  echo "    certbot renew will now pick it up automatically every 12h."
fi
