# Production Deploy

Target:

- `qr.crunchhaus.ru` -> QR guest/admin app
- `crm.crunchhaus.ru` -> temporary CRM placeholder until CRM is deployed
- app process: `127.0.0.1:4173`
- data: `/var/lib/qrnastol/app.json`

Server baseline:

```bash
apt update
apt install -y curl ca-certificates git nginx ufw fail2ban
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

Create app user and folders:

```bash
adduser --system --group --home /opt/qrnastol qrnastol
mkdir -p /opt/qrnastol /var/lib/qrnastol
chown -R qrnastol:qrnastol /opt/qrnastol /var/lib/qrnastol
```

Install app:

```bash
cd /opt/qrnastol
npm ci
npm run build
cp deploy/env.production.example .env
chmod 600 .env
```

Edit `.env`, then install services:

```bash
cp deploy/qrnastol.service /etc/systemd/system/qrnastol.service
cp deploy/backup-qrnastol.sh /usr/local/sbin/backup-qrnastol
chmod +x /usr/local/sbin/backup-qrnastol
cp deploy/nginx-qrnastol.conf /etc/nginx/sites-available/qrnastol.conf
cp deploy/nginx-crm-placeholder.conf /etc/nginx/sites-available/crm-placeholder.conf
ln -s /etc/nginx/sites-available/qrnastol.conf /etc/nginx/sites-enabled/qrnastol.conf
ln -s /etc/nginx/sites-available/crm-placeholder.conf /etc/nginx/sites-enabled/crm-placeholder.conf
echo "17 3 * * * root /usr/local/sbin/backup-qrnastol" >/etc/cron.d/qrnastol-backup
nginx -t
systemctl daemon-reload
systemctl enable --now qrnastol
systemctl reload nginx
```

After DNS points to the server:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d qr.crunchhaus.ru --redirect
certbot --nginx -d crm.crunchhaus.ru --redirect
```

If the provider resolves `api.telegram.org` to an unreachable Telegram IP, pin a reachable IPv4 before starting the service:

```bash
cp /etc/hosts "/etc/hosts.bak.$(date +%Y%m%d%H%M%S)"
sed -i '/api.telegram.org/d' /etc/hosts
echo "149.154.167.220 api.telegram.org # qrnastol telegram api route" >>/etc/hosts
systemctl restart qrnastol
```
