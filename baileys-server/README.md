# Baileys WhatsApp Checker Server

Node.js server for WhatsApp number verification using Baileys library.

> ⚠️ **This is a standalone repository** - Do NOT mix with Telegram Checker Bot code

---

## 📋 Quick Reference

| Item | Value |
|------|-------|
| **Runtime** | Node.js |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |

---

## 🔧 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | ✅ | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | ✅ | Service Role Key |
| `PORT` | ❌ | Auto-set by hosting platform |

---

## 📚 Documentation

- **[SETUP.md](./SETUP.md)** - Detailed setup guide with commands
- **[config.example.js](./config.example.js)** - Configuration template

---

## 🚀 Quick Deploy (Render)

1. Create new Web Service on [render.com](https://render.com)
2. Connect your GitHub repo
3. Set environment variables (see above)
4. Deploy!

---

## 📡 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/status` | GET | Connection status |
| `/qr` | GET | Get QR code |
| `/connect` | POST | Start connection |
| `/disconnect` | POST | Logout |
| `/reconnect` | POST | Force reconnect |
| `/pair` | POST | Get pairing code |
| `/check` | POST | Check single number |
| `/check-batch` | POST | Check batch |

---

## 🔗 Integration

After deployment, add your server URL as `BAILEYS_SERVER_URL` secret in Lovable.
