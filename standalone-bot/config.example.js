// Copy this file to config.js and fill in your values
// OR set these as environment variables on Render

module.exports = {
  // ── Required ────────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || 'your_bot_token_here',
  OWNER_ID:           parseInt(process.env.OWNER_ID)  || 0,

  // ── Server ──────────────────────────────────────────────────────────────
  PORT: parseInt(process.env.PORT) || 3000,

  // ── Admins (comma-separated IDs) ────────────────────────────────────────
  ADMIN_IDS: process.env.ADMIN_IDS
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim()))
    : [],

  // ── Bot defaults ────────────────────────────────────────────────────────
  BOT_MODE:    process.env.BOT_MODE    || 'private',
  BATCH_LIMIT: parseInt(process.env.BATCH_LIMIT) || 100,

  // ── Supabase (session persistence across Render deploys) ────────────────
  SUPABASE_URL:        process.env.SUPABASE_URL    || '',
  SUPABASE_SERVICE_KEY: process.env.SB_SERVICE_KEY || '',

  // ── Log group ───────────────────────────────────────────────────────────
  // Group/channel ID where all events are logged  e.g. -1001234567890
  LOG_GROUP_ID: parseInt(process.env.LOG_GROUP_ID) || 0,

  // ── Force Subscribe ─────────────────────────────────────────────────────
  // Channel username or ID  e.g. @mychannel  or  -1001234567890
  // If set here, overrides the value saved in bot settings on every restart
  // FSUB_CHANNEL: process.env.FSUB_CHANNEL || '',

  // ── Images (Telegram file_id OR direct https:// URL) ────────────────────
  // Main menu banner image — shown with the welcome message
  // To get a file_id: send the photo to bot, then set via Admin Panel > Settings > Set Menu Image
  // MENU_IMAGE:  process.env.MENU_IMAGE  || '',

  // Force-sub prompt image — shown with the "join channel" message
  // FSUB_IMAGE:  process.env.FSUB_IMAGE  || '',
};