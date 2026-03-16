/**
 * ============================================
 * WhatsApp Checker Bot - Configuration File
 * ============================================
 * 
 * Copy this file to config.js and update with your values
 * Command: cp config.example.js config.js
 * 
 * NOTE: config.js is gitignored for security
 */

export default {
  // ============================================
  // SUPABASE CONFIGURATION
  // ============================================
  
  // Your Supabase project URL
  SUPABASE_URL: "https://your-project-id.supabase.co",
  
  // Your Supabase SERVICE ROLE key (NOT anon key!)
  // Get from: Supabase Dashboard → Settings → API → service_role key
  SUPABASE_SERVICE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  
  // ============================================
  // SERVER CONFIGURATION
  // ============================================
  
  // Port for the server (default: 3000, Render automatically sets PORT)
  PORT: 3000,
  
  // ============================================
  // WHATSAPP CONFIGURATION
  // ============================================
  
  // Browser identification for WhatsApp Web
  // Format: [Platform, Browser, Version]
  // Recommended: Keep as is to avoid connection issues
  BROWSER_ID: ["Ubuntu", "Chrome", "20.0.04"],
  
  // Maximum reconnection attempts
  MAX_RETRIES: 5,
  
  // Delay between batch checks (in milliseconds)
  // Lower = faster but risk of rate limiting
  // Higher = slower but safer
  BATCH_CHECK_DELAY_MS: 50,
};
