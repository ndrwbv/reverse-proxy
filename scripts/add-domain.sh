#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Add SSL certificate for a new domain
#
# Assumes DNS is already pointing to this server and nginx conf.d
# already has the HTTP server block for the domain.
#
# Usage:
#   cd /opt/reverse-proxy
#   bash scripts/add-domain.sh example.com
###############################################################################

DOMAIN="${1:?Usage: $0 <domain>}"
EMAIL="${EMAIL:-admin@${DOMAIN}}"
STAGING="${STAGING:-0}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

echo "==> Requesting SSL certificate for ${DOMAIN}..."

STAGING_FLAG=""
if [ "$STAGING" -eq 1 ]; then
  STAGING_FLAG="--staging"
  echo "    (using staging server)"
fi

docker-compose exec -T certbot certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  -d "$DOMAIN" \
  $STAGING_FLAG

echo "==> Reloading nginx..."
docker-compose exec nginx nginx -s reload

echo ""
echo "==> SSL certificate for ${DOMAIN} is ready!"
echo "==> https://${DOMAIN} should now work"
