#!/usr/bin/env bash
# Oracle Cloud (Ubuntu 22.04/24.04) 用セットアップ。memescout フォルダの中で実行:
#   bash deploy/setup.sh あなたのサブドメイン.duckdns.org
set -euo pipefail
DOMAIN="${1:?使い方: bash deploy/setup.sh xxx.duckdns.org}"
cd "$(dirname "$0")/.."
APP="$(pwd)"

echo "== Node.js 22 =="
if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "== Caddy（HTTPS自動化） =="
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update && sudo apt-get install -y caddy
fi
sed "s/YOUR-NAME.duckdns.org/${DOMAIN}/" deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl restart caddy

echo "== ファイアウォール（Oracle Ubuntuは初期状態で80/443が閉じている） =="
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT || true
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT || true
sudo apt-get install -y iptables-persistent >/dev/null 2>&1 || true
sudo netfilter-persistent save || true

echo "== .env =="
if [ ! -f .env ]; then
  cp .env.example .env
  TOKEN="$(openssl rand -hex 24)"
  sed -i "s/^ACCESS_TOKEN=.*/ACCESS_TOKEN=${TOKEN}/" .env
  echo "ACCESS_TOKEN を自動生成しました: ${TOKEN}"
  echo "（アプリのログインに使います。メモしてください）"
fi

echo "== テスト =="
npm test

echo "== 常駐サービス =="
sed -e "s#/home/ubuntu/memescout#${APP}#" -e "s/^User=ubuntu/User=$(whoami)/" deploy/memescout.service | sudo tee /etc/systemd/system/memescout.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now memescout
sleep 2
sudo systemctl --no-pager status memescout | head -5
echo
echo "完了: iPhoneのSafariで https://${DOMAIN} を開いてください"
