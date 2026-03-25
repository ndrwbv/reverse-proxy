#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Initial SSL certificate setup for a domain via Let's Encrypt
#
# Usage:
#   cd /opt/reverse-proxy
#   bash scripts/init-letsencrypt.sh severbus.ru
#   bash scripts/init-letsencrypt.sh slotik.tech    # if re-issuing
#
# Set STAGING=1 to test without rate limits:
#   STAGING=1 bash scripts/init-letsencrypt.sh severbus.ru
#
# After this, the certbot container auto-renews every 12h.
###############################################################################

DOMAIN="${1:?Usage: $0 <domain>}"
EMAIL="${EMAIL:-admin@${DOMAIN}}"
STAGING="${STAGING:-0}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

echo "==> Starting SSL initialization for ${DOMAIN}"

# 1. Prepare directories
mkdir -p certbot/conf certbot/www

# 2. Temporarily use HTTP-only nginx configs
echo "==> Switching to HTTP-only nginx config..."
cp docker-compose.yml docker-compose.yml.bak
sed -i.tmp "s|./nginx/conf.d:/etc/nginx/conf.d|./nginx/conf.d-init:/etc/nginx/conf.d|" docker-compose.yml
rm -f docker-compose.yml.tmp

restore_compose() {
  echo "==> Restoring original docker-compose.yml..."
  mv docker-compose.yml.bak docker-compose.yml
}
trap restore_compose EXIT

# 3. Restart nginx with HTTP-only config
docker-compose up -d nginx
echo "==> Waiting for nginx to start..."
sleep 5

# 4. Request certificate
echo "==> Requesting certificate from Let's Encrypt..."
STAGING_FLAG=""
if [ "$STAGING" -eq 1 ]; then
  STAGING_FLAG="--staging"
  echo "    (using staging server — cert will NOT be trusted)"
fi

docker run --rm \
  -v "$(pwd)/certbot/conf:/etc/letsencrypt" \
  -v "$(pwd)/certbot/www:/var/www/certbot" \
  certbot/certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  -d "$DOMAIN" \
  $STAGING_FLAG

# 5. Restore HTTPS config and restart
trap - EXIT
restore_compose
docker-compose down
docker-compose up -d

echo ""
echo "==> SSL initialized successfully for ${DOMAIN}!"
echo "==> https://${DOMAIN} is now live"
echo "==> Certificate auto-renewal is handled by certbot container"
