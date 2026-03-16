# WhatsApp Checker Bot - Setup Guide

## 📋 Required Environment Variables

Set these in your hosting platform (Render, Railway, etc.):

| Variable | Description | Where to Get |
|----------|-------------|--------------|
| `SUPABASE_URL` | Your Supabase project URL | Lovable → Settings → Connectors → Lovable Cloud |
| `SUPABASE_SERVICE_KEY` | Service Role Key (NOT anon key) | Lovable → Settings → Connectors → Lovable Cloud → Service Role Key |
| `PORT` | Server port (optional) | Auto-set by Render/Railway |

---

## 🚀 Deployment Commands

### For Render.com:

| Setting | Value |
|---------|-------|
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | Free (or Starter for better uptime) |

### For Railway:

| Setting | Value |
|---------|-------|
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |

### For Local Development:

```bash
# Install dependencies
npm install

# Start server
npm start

# Or with nodemon for development
npx nodemon index.js
```

---

## 📁 Project Structure

```
baileys-server/
├── index.js          # Main server file
├── package.json      # Dependencies
├── config.example.js # Example configuration
├── SETUP.md          # This file
└── README.md         # General documentation
```

---

## 🔗 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/status` | GET | WhatsApp connection status |
| `/qr` | GET | Get QR code for scanning |
| `/connect` | POST | Start new connection (generates QR) |
| `/disconnect` | POST | Logout and clear session |
| `/reconnect` | POST | Force reconnect |
| `/pair` | POST | Get pairing code |
| `/check` | POST | Check single number |
| `/check-batch` | POST | Check multiple numbers |

---

## ⚙️ Environment Setup Example

### Render Dashboard:

1. Go to your Render service → Environment
2. Add these variables:

```
SUPABASE_URL=https://bzanrtbstsccvsbbpmpr.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### .env file (Local only - DO NOT COMMIT):

```env
SUPABASE_URL=https://bzanrtbstsccvsbbpmpr.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key_here
PORT=3000
```

---

## 🔒 Security Notes

- ⚠️ NEVER commit `config.js` or `.env` files
- ⚠️ Use SERVICE_ROLE key only on backend (never in frontend)
- ⚠️ Keep session files (`auth_state/`) private

---

## 🐛 Troubleshooting

### QR Code not generating
- Check if server is running: `GET /health`
- Restart connection: `POST /reconnect`

### "Couldn't link device" error
- Browser ID is already set to `Ubuntu, Chrome, 20.0.04`
- Try `/reconnect` and scan within 20 seconds

### Session not persisting
- Verify `SUPABASE_SERVICE_KEY` is correct
- Check Supabase → `whatsapp_sessions` table exists

---

## 📞 After Deployment

1. Copy your Render URL (e.g., `https://baileys-server.onrender.com`)
2. Add as `BAILEYS_SERVER_URL` secret in Lovable project
3. Test: `GET https://your-url.onrender.com/health`
