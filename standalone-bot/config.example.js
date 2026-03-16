// Copy this file to config.js and fill in your values
// OR set these as environment variables on Render

module.exports = {
  // Required: Get from @BotFather on Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || 'your_bot_token_here',
  
  // Required: Your Telegram user ID (get from @userinfobot)
  OWNER_ID: parseInt(process.env.OWNER_ID) || 0,
  
  // Optional: Port for the web server (Render sets this automatically)
  PORT: parseInt(process.env.PORT) || 3000,
  
  // Optional: Admin user IDs (comma-separated in env)
  ADMIN_IDS: process.env.ADMIN_IDS 
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim()))
    : [],
    
  // Optional: Bot mode - 'public' or 'private'
  BOT_MODE: process.env.BOT_MODE || 'private',
  
  // Optional: Max numbers per batch
  BATCH_LIMIT: parseInt(process.env.BATCH_LIMIT) || 100,

  // Supabase (for session persistence across Render deploys)
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_KEY: process.env.SB_SERVICE_KEY || ''
};
