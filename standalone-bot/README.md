# WhatsApp Checker Bot - Standalone Version

Ye poora bot Render (ya kisi bhi VPS) pe chalega. **Koi Lovable ya Supabase ki zaroorat nahi.**

## Features
- ✅ Telegram Bot for WhatsApp number checking
- ✅ WhatsApp connection via Baileys
- ✅ SQLite database (no external DB needed)
- ✅ All commands: /start, /check, /connect, /status, etc.
- ✅ Session persistence

## Setup on Render

### Step 1: Create a new Web Service
1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **New** → **Web Service**
3. Connect your GitHub repo

### Step 2: Configure the Service
```
Name: whatsapp-checker-bot
Environment: Node
Build Command: cd standalone-bot && npm install
Start Command: cd standalone-bot && node index.js
```

### Step 3: Add Environment Variables
```
TELEGRAM_BOT_TOKEN = your_telegram_bot_token_here
OWNER_ID = your_telegram_user_id (get from @userinfobot)
```

### Step 4: Deploy
Click **Create Web Service** and wait for deployment.

## Local Development

```bash
cd standalone-bot
npm install
cp config.example.js config.js
# Edit config.js with your values
node index.js
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot |
| `/help` | Show all commands |
| `/connect` | Get QR code to connect WhatsApp |
| `/pair <number>` | Connect via pairing code |
| `/status` | Check WhatsApp connection status |
| `/reconnect` | Force reconnect WhatsApp |
| `/disconnect` | Logout from WhatsApp |

**Number Checking:**
- Send any phone number: `919876543210`
- Send file with numbers (one per line)

## Token Update Kaise Karein?

### Method 1: Render Dashboard
1. [Render Dashboard](https://dashboard.render.com) pe jaao
2. Apna service select karo
3. **Environment** tab mein jaao
4. `TELEGRAM_BOT_TOKEN` update karo
5. **Save Changes** → Service auto-redeploy hogi

### Method 2: config.js (Local)
```javascript
// config.js
module.exports = {
  TELEGRAM_BOT_TOKEN: 'new_token_here',
  OWNER_ID: 123456789
};
```

## File Structure
```
standalone-bot/
├── index.js          # Main bot + WhatsApp server
├── package.json      # Dependencies
├── config.example.js # Example config
├── database.js       # SQLite helper
└── README.md         # This file
```
