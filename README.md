# SecureChat Relay Server

A minimal, stateless WebSocket relay for SecureChat.

**What it does:** Routes encrypted message blobs between devices.  
**What it never does:** Store message content, read payloads, or know user identities.

---

## Event Protocol

### Client → Relay
| Event | Fields | Description |
|---|---|---|
| `connect` | `device_id` | Register on connect |
| `send` | `to`, `msg_id`, `payload` | Send encrypted blob |
| `ack_stored` | `msg_id`, `to` | I saved the message to SQLite |
| `ack_seen` | `msg_id`, `to` | User opened the message |
| `pull_acks` | `device_id` | Fetch queued ACKs after reconnect |

### Relay → Client
| Event | Fields | Description |
|---|---|---|
| `connected` | `device_id` | Registration confirmed |
| `message` | `from`, `msg_id`, `payload` | Incoming encrypted blob |
| `ack_sent` | `msg_id` | Relay received your message ✓ |
| `ack_stored` | `msg_id` | Recipient stored it ✓✓ |
| `ack_seen` | `msg_id` | Recipient saw it ✓✓✓ |
| `dropped` | `msg_id` | Recipient offline, message dropped |
| `pending_acks` | `acks[]` | Response to pull_acks |

---

## Local Development

```bash
npm install
npm run dev       # nodemon auto-reload
node test.js      # integration tests (server must be running)
```

---

## Deployment

### Option A — Railway.app (Recommended, Free Tier)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo → Railway auto-detects the Dockerfile
4. Add environment variables in Railway dashboard:
   ```
   PORT=8080
   ACK_TTL_HOURS=24
   CLEANUP_INTERVAL_MINUTES=60
   ```
5. Railway gives you a public URL like `wss://your-app.railway.app`
6. Use that URL in your mobile app as `RELAY_URL`

### Option B — Render.com (Free Tier)

1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service → Connect repo
3. Set:
   - **Environment:** Docker
   - **Plan:** Free
4. Add env vars same as above
5. Your URL will be `wss://your-app.onrender.com`

> ⚠️ Render free tier spins down after 15 min inactivity. Use Railway for always-on.

### Option C — VPS (DigitalOcean / Hetzner)

```bash
# On your server
git clone <your-repo>
cd relay
docker build -t securechat-relay .
docker run -d \
  --name relay \
  --restart unless-stopped \
  -p 8080:8080 \
  -e PORT=8080 \
  -e ACK_TTL_HOURS=24 \
  -e CLEANUP_INTERVAL_MINUTES=60 \
  securechat-relay
```

Then put Nginx in front for WSS (TLS):

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

Get a free TLS cert: `certbot --nginx -d your-domain.com`

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | WebSocket server port |
| `ACK_TTL_HOURS` | `24` | How long to hold queued ACKs |
| `CLEANUP_INTERVAL_MINUTES` | `60` | How often to purge expired ACKs |
