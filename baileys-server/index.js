import express from 'express';
import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

const logger = pino({ level: 'info' });

// Supabase client for session persistence
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Store for active socket
let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected';
let retryCount = 0;
const MAX_RETRIES = 5;

// Session directory
const SESSION_DIR = './auth_state';

// Save session to Supabase
async function saveSessionToSupabase() {
  try {
    if (!fs.existsSync(SESSION_DIR)) return;
    
    const files = fs.readdirSync(SESSION_DIR);
    const sessionData = {};
    
    for (const file of files) {
      const content = fs.readFileSync(path.join(SESSION_DIR, file), 'utf-8');
      sessionData[file] = content;
    }
    
    await supabase
      .from('whatsapp_sessions')
      .upsert({
        session_id: 'main',
        session_data: sessionData,
        is_connected: connectionStatus === 'connected',
        updated_at: new Date().toISOString()
      }, { onConflict: 'session_id' });
      
    logger.info('Session saved to Supabase');
  } catch (error) {
    logger.error('Failed to save session:', error);
  }
}

// Load session from Supabase
async function loadSessionFromSupabase() {
  try {
    const { data } = await supabase
      .from('whatsapp_sessions')
      .select('session_data')
      .eq('session_id', 'main')
      .single();
    
    if (data?.session_data && Object.keys(data.session_data).length > 0) {
      if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
      }
      
      for (const [filename, content] of Object.entries(data.session_data)) {
        fs.writeFileSync(path.join(SESSION_DIR, filename), content);
      }
      
      logger.info('Session loaded from Supabase');
      return true;
    }
  } catch (error) {
    logger.error('Failed to load session:', error);
  }
  return false;
}

// Clear session
async function clearSession() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    }
    
    await supabase
      .from('whatsapp_sessions')
      .update({ 
        session_data: {}, 
        is_connected: false,
        updated_at: new Date().toISOString()
      })
      .eq('session_id', 'main');
      
    logger.info('Session cleared');
  } catch (error) {
    logger.error('Failed to clear session:', error);
  }
}

// Initialize WhatsApp connection
async function connectToWhatsApp() {
  try {
    // Load session from Supabase first
    await loadSessionFromSupabase();
    
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });
    
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      await saveSessionToSupabase();
    });
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        qrCode = await QRCode.toDataURL(qr);
        connectionStatus = 'waiting_for_scan';
        logger.info('QR code generated');
      }
      
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        connectionStatus = 'disconnected';
        qrCode = null;
        
        await supabase
          .from('whatsapp_sessions')
          .update({ is_connected: false, updated_at: new Date().toISOString() })
          .eq('session_id', 'main');
        
        if (statusCode === DisconnectReason.loggedOut) {
          logger.info('Logged out, clearing session');
          await clearSession();
          retryCount = 0;
        } else if (shouldReconnect && retryCount < MAX_RETRIES) {
          retryCount++;
          logger.info(`Reconnecting... attempt ${retryCount}`);
          setTimeout(connectToWhatsApp, 3000);
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        qrCode = null;
        retryCount = 0;
        
        const phoneNumber = sock.user?.id?.split(':')[0] || null;
        
        await supabase
          .from('whatsapp_sessions')
          .update({ 
            is_connected: true, 
            phone_number: phoneNumber,
            updated_at: new Date().toISOString()
          })
          .eq('session_id', 'main');
        
        logger.info('Connected to WhatsApp!');
        await saveSessionToSupabase();
      }
    });
    
  } catch (error) {
    logger.error('Connection error:', error);
    connectionStatus = 'error';
  }
}

// Check if number is on WhatsApp
async function checkWhatsAppNumber(phoneNumber) {
  if (!sock || connectionStatus !== 'connected') {
    return { error: 'WhatsApp not connected', is_registered: null };
  }
  
  try {
    // Format number (remove + and ensure no extra characters)
    const formattedNumber = phoneNumber.replace(/[^\d]/g, '');
    const jid = `${formattedNumber}@s.whatsapp.net`;
    
    const [result] = await sock.onWhatsApp(jid);
    
    return {
      phone_number: phoneNumber,
      is_registered: result?.exists === true,
      jid: result?.jid || null
    };
  } catch (error) {
    logger.error(`Error checking ${phoneNumber}:`, error);
    return { 
      phone_number: phoneNumber, 
      is_registered: false, 
      error: error.message 
    };
  }
}

// API Routes
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    whatsapp: connectionStatus,
    hasQR: !!qrCode
  });
});

app.get('/status', (req, res) => {
  res.json({
    connected: connectionStatus === 'connected',
    status: connectionStatus,
    phone: sock?.user?.id?.split(':')[0] || null
  });
});

app.get('/qr', (req, res) => {
  if (connectionStatus === 'connected') {
    res.json({ status: 'already_connected' });
  } else if (qrCode) {
    res.json({ qr: qrCode, status: 'waiting_for_scan' });
  } else {
    res.json({ status: connectionStatus, message: 'QR not available yet' });
  }
});

app.post('/connect', async (req, res) => {
  if (connectionStatus === 'connected') {
    res.json({ status: 'already_connected' });
    return;
  }
  
  await clearSession();
  retryCount = 0;
  connectToWhatsApp();
  
  res.json({ status: 'connecting', message: 'Check /qr for QR code' });
});

app.post('/disconnect', async (req, res) => {
  if (sock) {
    await sock.logout();
    sock = null;
  }
  await clearSession();
  connectionStatus = 'disconnected';
  qrCode = null;
  
  res.json({ status: 'disconnected' });
});

app.post('/reconnect', async (req, res) => {
  if (sock) {
    try {
      sock.end();
    } catch (e) {}
    sock = null;
  }
  await clearSession();
  connectionStatus = 'disconnected';
  qrCode = null;
  retryCount = 0;
  
  setTimeout(connectToWhatsApp, 1000);
  
  res.json({ status: 'reconnecting' });
});

app.post('/check', async (req, res) => {
  const { phone_number } = req.body;
  
  if (!phone_number) {
    res.status(400).json({ error: 'phone_number required' });
    return;
  }
  
  const result = await checkWhatsAppNumber(phone_number);
  res.json(result);
});

app.post('/check-batch', async (req, res) => {
  const { phone_numbers } = req.body;
  
  if (!phone_numbers || !Array.isArray(phone_numbers)) {
    res.status(400).json({ error: 'phone_numbers array required' });
    return;
  }
  
  // Sequential processing for 100% accuracy (one at a time)
  // Reduced delay to 50ms - still accurate but 3x faster
  const results = [];
  
  logger.info(`Processing ${phone_numbers.length} numbers SEQUENTIALLY (50ms delay)`);
  
  const startTime = Date.now();
  
  for (let i = 0; i < phone_numbers.length; i++) {
    const number = phone_numbers[i];
    const result = await checkWhatsAppNumber(number);
    results.push(result);
    
    // 50ms delay between each check - fast but safe
    if (i < phone_numbers.length - 1) {
      await new Promise(r => setTimeout(r, 50));
    }
    
    // Log progress every 25 numbers for faster feedback
    if ((i + 1) % 25 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`Progress: ${i + 1}/${phone_numbers.length} checked (${elapsed}s)`);
    }
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const registered = results.filter(r => r.is_registered === true).length;
  logger.info(`Completed: ${registered}/${phone_numbers.length} registered in ${elapsed}s`);
  
  res.json({ results });
});

app.post('/pair', async (req, res) => {
  const { phone_number } = req.body;
  
  if (!phone_number) {
    res.status(400).json({ error: 'phone_number required' });
    return;
  }
  
  if (connectionStatus === 'connected') {
    res.json({ status: 'already_connected' });
    return;
  }
  
  try {
    await clearSession();
    
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04']
    });
    
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      await saveSessionToSupabase();
    });
    
    sock.ev.on('connection.update', async (update) => {
      const { connection } = update;
      if (connection === 'open') {
        connectionStatus = 'connected';
        await saveSessionToSupabase();
      }
    });
    
    // Wait for socket to be ready
    await new Promise(r => setTimeout(r, 2000));
    
    const formattedNumber = phone_number.replace(/[^\d]/g, '');
    const code = await sock.requestPairingCode(formattedNumber);
    
    res.json({ 
      status: 'pairing_code_sent',
      code: code,
      message: `Enter this code in WhatsApp: ${code}`
    });
  } catch (error) {
    logger.error('Pairing error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  
  // Auto-connect if session exists
  const hasSession = await loadSessionFromSupabase();
  if (hasSession) {
    logger.info('Found existing session, connecting...');
    connectToWhatsApp();
  }
});
