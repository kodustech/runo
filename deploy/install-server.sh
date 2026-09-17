#!/usr/bin/env bash
# Execute on the new Ohio host after copying the deployment inputs into ubuntu's home.
set -euo pipefail
cloud-init status --wait
tar -xzf /home/ubuntu/runo.tar.gz -C /opt/runo
cd /opt/runo
/home/ubuntu/.bun/bin/bun install --production --frozen-lockfile
sudo install -o root -g root -m 600 /home/ubuntu/aws.env /etc/runo-aws.env
sudo install -o root -g root -m 600 /home/ubuntu/server.env /etc/runo-server.env
install -m 600 /home/ubuntu/isolated-policies.yaml /var/lib/runo-ohio/policies.yaml
sudo install -o root -g root -m 644 /home/ubuntu/Caddyfile /etc/caddy/Caddyfile
sudo systemctl enable --now runo-server
sudo systemctl reload caddy
rm /home/ubuntu/aws.env /home/ubuntu/server.env
systemctl is-active runo-server caddy
