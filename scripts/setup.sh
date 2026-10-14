#!/usr/bin/env sh
# Create .env from .env.example with freshly generated secrets.
set -eu
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env already exists; not overwriting. Delete it to regenerate." >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

jwt=$(openssl rand -base64 48 | tr -d '\n')
api=$(openssl rand -hex 32)
storage=$(openssl rand -hex 32)
password=$(openssl rand -base64 18 | tr -d '\n/+=')

sed -e "s|^JWT_SECRET=.*|JWT_SECRET=$jwt|" \
    -e "s|^API_KEY_SECRET=.*|API_KEY_SECRET=$api|" \
    -e "s|^STORAGE_ENCRYPTION_KEY=.*|STORAGE_ENCRYPTION_KEY=$storage|" \
    -e "s|^INITIAL_PASSWORD=.*|INITIAL_PASSWORD=$password|" \
    .env.example > .env
chmod 600 .env

echo "Created .env with generated secrets."
echo "Initial dashboard password: $password"
echo "Keep STORAGE_ENCRYPTION_KEY safe: losing it makes the stored data unreadable."
