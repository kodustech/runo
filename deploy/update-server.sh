#!/usr/bin/env bash
# Code-only update of the Ohio control plane: ships the working tree, keeps
# /etc/runo-*.env and $RUNO_HOME untouched, rolls back if the new build does
# not come up. Run from the repo root on the operator machine.
set -euo pipefail
HOST=ubuntu@3.14.180.98
PUBLIC_URL=https://runo.kodus.io
SSH=(ssh -i .runo-deploy/operator -o UserKnownHostsFile=.runo-deploy/known_hosts
  -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o ConnectTimeout=10)

bun test ./server/
bundle=.runo-deploy/runo-$(git rev-parse --short HEAD)-$(date +%Y%m%d%H%M%S).tar.gz
# no macOS xattrs: GNU tar on the host warns about every one of them
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$bundle" bin image server src package.json bun.lock
scp "${SSH[@]:1}" "$bundle" "$HOST:/home/ubuntu/runo-update.tar.gz"

"${SSH[@]}" "$HOST" PUBLIC_URL="$PUBLIC_URL" bash -s <<'REMOTE'
set -euo pipefail
backup=/home/ubuntu/runo-backup-$(date +%Y%m%d%H%M%S).tar.gz
tar -czf "$backup" -C /opt/runo --exclude=node_modules .
echo "backup: $backup"

rollback() {
  echo "new build is not healthy — rolling back" >&2
  sudo journalctl -u runo-server -n 30 --no-pager >&2 || true
  tar -xzf "$backup" -C /opt/runo
  sudo systemctl restart runo-server
  exit 1
}

tar -xzf /home/ubuntu/runo-update.tar.gz -C /opt/runo
rm -f /opt/runo/server/panel.html /home/ubuntu/runo-update.tar.gz
(cd /opt/runo && /home/ubuntu/.bun/bin/bun install --production --frozen-lockfile)
# https public URL => Secure, __Host- prefixed session cookie
sudo grep -q '^RUNO_PUBLIC_URL=' /etc/runo-server.env ||
  echo "RUNO_PUBLIC_URL=$PUBLIC_URL" | sudo tee -a /etc/runo-server.env >/dev/null
sudo systemctl restart runo-server
sleep 4
systemctl is-active --quiet runo-server || rollback
# /auth/config only exists in the new build
[[ $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7777/auth/config) == 200 ]] || rollback
ls -la /var/lib/runo-ohio/server.db
echo "deployed"
REMOTE

curl -fsS "$PUBLIC_URL/auth/config" && echo
