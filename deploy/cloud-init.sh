#!/bin/bash
# Oracle Cloud のインスタンス作成時に「cloud-initスクリプト」から自動実行される設置スクリプト（root権限で実行）
# 必要な環境変数: DOMAIN（例 myscout.duckdns.org）, TOKEN（アプリのパスワード）, DUCKDNS_TOKEN（任意: IP自動登録）
set -uo pipefail
exec > >(tee -a /var/log/memescout-setup.log) 2>&1
echo "=== Meme Scout setup start $(date) ==="
REPO="https://github.com/s14-114ws-cloud/meme-coin.git"
U=ubuntu
HOME_DIR=/home/$U
APP=$HOME_DIR/memescout
SUB="${DOMAIN%%.duckdns.org}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

# --- DuckDNS: このサーバーのIPを自動登録（5分ごとに更新）---
if [ -n "${DUCKDNS_TOKEN:-}" ]; then
  echo "*/5 * * * * root curl -fsS 'https://www.duckdns.org/update?domains=${SUB}&token=${DUCKDNS_TOKEN}&ip=' >/dev/null 2>&1" > /etc/cron.d/duckdns
  curl -fsS "https://www.duckdns.org/update?domains=${SUB}&token=${DUCKDNS_TOKEN}&ip=" ; echo
fi

# --- Node.js 22 ---
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# --- アプリ本体 ---
sudo -u $U git clone --depth 1 "$REPO" "$APP"
cd "$APP"
if [ ! -f .env ]; then
  sudo -u $U cp .env.example .env
  sed -i "s/^ACCESS_TOKEN=.*/ACCESS_TOKEN=${TOKEN}/" .env
fi

# --- ファイアウォール（Oracle Ubuntuは80/443が初期状態で閉じている）---
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
netfilter-persistent save

# --- Caddy（HTTPS証明書を自動取得）---
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y && apt-get install -y caddy
sed "s/YOUR-NAME.duckdns.org/${DOMAIN}/" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl restart caddy

# --- 常駐サービス ---
cp deploy/memescout.service /etc/systemd/system/memescout.service
systemctl daemon-reload
systemctl enable --now memescout

# --- 毎日4時(JST)に GitHub の最新版へ自動更新 ---
cat > /etc/cron.d/memescout-update <<EOF
0 19 * * * $U cd $APP && git fetch -q origin main && [ "\$(git rev-parse HEAD)" != "\$(git rev-parse origin/main)" ] && git reset -q --hard origin/main && sudo systemctl restart memescout
EOF
echo "$U ALL=(root) NOPASSWD: /usr/bin/systemctl restart memescout" > /etc/sudoers.d/memescout
chmod 440 /etc/sudoers.d/memescout

echo "=== Meme Scout setup done $(date) ==="
