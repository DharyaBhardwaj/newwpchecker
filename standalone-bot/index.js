const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const db = require('./database');

// Load config
let config;
try { config = require('./config'); } catch (e) { config = require('./config.example'); }

const logger = pino({ level: 'info' });
const app = express();
app.use(express.json());

// ========== SUPABASE ==========
let supabase = null;
if (config.SUPABASE_URL && config.SUPABASE_SERVICE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
  logger.info('Supabase initialized');
}

// ========== DATA DIR ==========
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : (fs.existsSync('/var/data') ? '/var/data' : path.join(__dirname, 'data'));
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ========== MULTI-ACCOUNT STATE ==========
// accountId => { sock, status, qrCode, retryCount, retryTimer, phoneNumber }
// status: 'disconnected' | 'connecting' | 'waiting_for_scan' | 'connected' | 'banned'
const accounts = new Map();

function getSessionDir(accountId) {
  return path.join(DATA_DIR, 'auth_' + accountId);
}

function getConnectedAccounts() {
  const result = [];
  for (const [id, state] of accounts.entries()) {
    if (state.status === 'connected' && state.sock) result.push({ id, ...state });
  }
  return result;
}

function hasAnyConnected() {
  return getConnectedAccounts().length > 0;
}

// ========== SUPABASE SESSION ==========
async function saveSessionToSupabase(accountId) {
  if (!supabase) return;
  const sessionDir = getSessionDir(accountId);
  try {
    if (!fs.existsSync(sessionDir)) return;
    const files = fs.readdirSync(sessionDir);
    const sessionData = {};
    for (const file of files) {
      sessionData[file] = fs.readFileSync(path.join(sessionDir, file), 'utf-8');
    }
    await supabase.from('whatsapp_sessions').upsert({
      session_id: accountId,
      session_data: sessionData,
      is_connected: accounts.get(accountId)?.status === 'connected',
      phone_number: accounts.get(accountId)?.phoneNumber || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'session_id' });
    logger.info(`[${accountId}] Session saved to Supabase`);
  } catch (err) {
    logger.error(`[${accountId}] Supabase save error:`, err);
  }
}

async function loadSessionFromSupabase(accountId) {
  if (!supabase) return false;
  const sessionDir = getSessionDir(accountId);
  try {
    const { data } = await supabase
      .from('whatsapp_sessions')
      .select('session_data')
      .eq('session_id', accountId)
      .single();
    if (data?.session_data && Object.keys(data.session_data).length > 0) {
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
      for (const [filename, content] of Object.entries(data.session_data)) {
        fs.writeFileSync(path.join(sessionDir, filename), content);
      }
      logger.info(`[${accountId}] Session loaded from Supabase`);
      return true;
    }
  } catch (err) {
    logger.error(`[${accountId}] Supabase load error:`, err);
  }
  return false;
}

async function clearSessionFromSupabase(accountId) {
  if (!supabase) return;
  try {
    await supabase.from('whatsapp_sessions')
      .update({ session_data: {}, is_connected: false, updated_at: new Date().toISOString() })
      .eq('session_id', accountId);
  } catch (_) {}
}

async function clearAccountSession(accountId) {
  const sessionDir = getSessionDir(accountId);
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  await clearSessionFromSupabase(accountId);
  db.setAccountConnected(accountId, false);
}

// ========== CONNECT SINGLE ACCOUNT ==========
const MAX_RETRIES = 50;

async function connectAccount(accountId) {
  const existing = accounts.get(accountId);
  if (existing?.status === 'connected') return;

  db.addAccount(accountId);

  if (!accounts.has(accountId)) {
    accounts.set(accountId, { status: 'connecting', sock: null, qrCode: null, retryCount: 0, retryTimer: null, phoneNumber: null });
  } else {
    const s = accounts.get(accountId);
    s.status = 'connecting';
    s.qrCode = null;
  }

  logger.info(`[${accountId}] Connecting...`);

  try {
    await loadSessionFromSupabase(accountId);

    const sessionDir = getSessionDir(accountId);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      keepAliveIntervalMs: 30_000,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
    });

    accounts.get(accountId).sock = sock;

    sock.ev.on('creds.update', async () => {
      try { await saveCreds(); await saveSessionToSupabase(accountId); } catch (e) {}
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const acct = accounts.get(accountId);
      if (!acct) return;

      if (qr) {
        acct.qrCode = await QRCode.toDataURL(qr);
        acct.status = 'waiting_for_scan';
        logger.info(`[${accountId}] QR generated`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isBanned = statusCode === DisconnectReason.loggedOut;

        logger.warn(`[${accountId}] Disconnected — code: ${statusCode}`);
        acct.status = isBanned ? 'banned' : 'disconnected';
        acct.sock = null;
        acct.qrCode = null;
        db.setAccountConnected(accountId, false);

        if (isBanned) {
          db.incrementBanCount(accountId); // also disables the account in DB
          logger.warn(`[${accountId}] BANNED! Auto-disabled.`);
          notifyAdminsBan(accountId);
          await clearAccountSession(accountId);
          return;
        }

        // Auto-reconnect with exponential backoff
        if (acct.retryCount < MAX_RETRIES) {
          acct.retryCount++;
          const backoff = Math.min(30_000, 2_000 * acct.retryCount);
          logger.info(`[${accountId}] Retry ${acct.retryCount} in ${backoff}ms`);
          acct.retryTimer = setTimeout(() => connectAccount(accountId), backoff);
        } else {
          logger.error(`[${accountId}] Max retries reached`);
        }
      }

      if (connection === 'open') {
        acct.status = 'connected';
        acct.qrCode = null;
        acct.retryCount = 0;
        acct.phoneNumber = sock.user?.id?.split(':')[0] || null;
        db.setAccountConnected(accountId, true, acct.phoneNumber);
        await saveSessionToSupabase(accountId);
        logger.info(`[${accountId}] Connected! Phone: ${acct.phoneNumber}`);
        notifyAdminsConnected(accountId, acct.phoneNumber);
      }
    });

  } catch (err) {
    logger.error(`[${accountId}] Connection error:`, err);
    const acct = accounts.get(accountId);
    if (acct) acct.status = 'disconnected';
  }
}

// ========== BOOT: CONNECT ALL SAVED ACCOUNTS ==========
async function connectAllSavedAccounts() {
  const saved = db.getAllAccounts();
  if (saved.length === 0) {
    logger.info('No WA accounts found. Add one via Telegram bot.');
    return;
  }
  logger.info(`Found ${saved.length} saved account(s). Connecting...`);
  for (const acct of saved) {
    if (!acct.is_enabled) {
      logger.info(`[${acct.account_id}] Skipped (disabled/banned)`);
      accounts.set(acct.account_id, { status: 'banned', sock: null, qrCode: null, retryCount: 0, retryTimer: null, phoneNumber: acct.phone_number });
      continue;
    }
    const sessionDir = getSessionDir(acct.account_id);
    const hasLocal = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;
    if (hasLocal || supabase) {
      await connectAccount(acct.account_id);
    } else {
      logger.info(`[${acct.account_id}] No session, skipping auto-connect`);
      accounts.set(acct.account_id, { status: 'disconnected', sock: null, qrCode: null, retryCount: 0, retryTimer: null, phoneNumber: acct.phone_number });
    }
  }
}

// ========== DISCONNECT ACCOUNT ==========
async function disconnectAccount(accountId) {
  const acct = accounts.get(accountId);
  if (acct?.retryTimer) clearTimeout(acct.retryTimer);
  if (acct?.sock) {
    try { await acct.sock.logout(); } catch (_) {}
    acct.sock = null;
  }
  if (acct) acct.status = 'disconnected';
  await clearAccountSession(accountId);
}

// ========== CHECK SINGLE NUMBER ON ONE ACCOUNT ==========
async function checkNumberOnAccount(accountId, phoneNumber) {
  const acct = accounts.get(accountId);
  if (!acct?.sock || acct.status !== 'connected') {
    return { phone_number: phoneNumber, is_registered: null, error: 'Account not connected', account: accountId };
  }
  try {
    const formatted = phoneNumber.replace(/[^\d]/g, '');
    const [result] = await acct.sock.onWhatsApp(`${formatted}@s.whatsapp.net`);
    db.incrementAccountChecks(accountId, 1);
    return { phone_number: phoneNumber, is_registered: result?.exists === true, account: accountId };
  } catch (err) {
    logger.error(`[${accountId}] Check error for ${phoneNumber}:`, err);
    return { phone_number: phoneNumber, is_registered: false, error: err.message, account: accountId };
  }
}

// ========== LOAD BALANCED BULK CHECK ==========
// Numbers distribute karo connected accounts mein.
// Agar koi account beech mein down ho — uske numbers wapas queue mein.
async function checkNumbersBalanced(numbers, onProgress) {
  const results = new Array(numbers.length).fill(null);
  // Pending = { idx, num }
  let pending = numbers.map((num, idx) => ({ idx, num }));
  let done = 0;

  while (pending.length > 0) {
    const active = getConnectedAccounts();

    if (active.length === 0) {
      logger.warn('No connected accounts. Waiting 10s for reconnect...');
      await sleep(10_000);
      if (getConnectedAccounts().length === 0) {
        // Give up — mark remaining as unknown
        for (const { idx, num } of pending) {
          results[idx] = { phone_number: num, is_registered: null, error: 'No accounts available' };
        }
        break;
      }
      continue;
    }

    // Distribute pending numbers evenly across active accounts
    const chunks = distributeToAccounts(pending, active);
    pending = []; // Will be repopulated if any account fails mid-run

    // All accounts work in parallel
    const failedByAccount = await Promise.all(
      chunks.map(async ({ accountId, items }) => {
        const failed = [];
        for (const { idx, num } of items) {
          // Re-check status before each number
          const acct = accounts.get(accountId);
          if (!acct || acct.status !== 'connected') {
            failed.push({ idx, num });
            continue;
          }
          const result = await checkNumberOnAccount(accountId, num);
          results[idx] = result;
          done++;
          if (onProgress) onProgress(done, numbers.length);
          await sleep(50); // 50ms delay between checks per account
        }
        return failed;
      })
    );

    // Re-queue failed items for redistribution to other accounts
    for (const failed of failedByAccount) {
      for (const item of failed) pending.push(item);
    }

    if (pending.length > 0) {
      logger.info(`${pending.length} numbers need redistribution (account went down)...`);
      await sleep(2_000);
    }
  }

  return results;
}

// Numbers ko N accounts mein equally baantna
function distributeToAccounts(items, activeAccounts) {
  const chunks = activeAccounts.map(a => ({ accountId: a.id, items: [] }));
  items.forEach((item, i) => chunks[i % chunks.length].items.push(item));
  return chunks.filter(c => c.items.length > 0);
}

// ========== PAIRING CODE ==========
async function getPairingCode(accountId, phoneNumber) {
  await clearAccountSession(accountId);
  db.addAccount(accountId);

  accounts.set(accountId, { status: 'connecting', sock: null, qrCode: null, retryCount: 0, retryTimer: null, phoneNumber: null });

  const sessionDir = getSessionDir(accountId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  accounts.get(accountId).sock = sock;

  sock.ev.on('creds.update', async () => { await saveCreds(); await saveSessionToSupabase(accountId); });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    const acct = accounts.get(accountId);
    if (!acct) return;
    if (connection === 'open') {
      acct.status = 'connected';
      acct.phoneNumber = sock.user?.id?.split(':')[0] || null;
      db.setAccountConnected(accountId, true, acct.phoneNumber);
      await saveSessionToSupabase(accountId);
      notifyAdminsConnected(accountId, acct.phoneNumber);
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        db.incrementBanCount(accountId);
        notifyAdminsBan(accountId);
        if (acct) acct.status = 'banned';
      } else {
        if (acct) { acct.status = 'disconnected'; acct.sock = null; }
      }
    }
  });

  await sleep(2000);
  const formatted = phoneNumber.replace(/[^\d]/g, '');
  const code = await sock.requestPairingCode(formatted);
  return code;
}

// ========== ADMIN NOTIFICATIONS ==========
function notifyAdminsBan(accountId) {
  const acct = db.getAccount(accountId);
  const label = escapeHtml(acct?.label || accountId);
  const phone = acct?.phone_number || 'unknown';
  broadcastToAdmins(`⚠️ <b>WhatsApp Account Banned!</b>\n\nAccount: <code>${label}</code>\nPhone: <code>${phone}</code>\n\nAuto-disabled. Add a new account via ➕ Add Account button.`);
}

function notifyAdminsConnected(accountId, phoneNumber) {
  const acct = db.getAccount(accountId);
  const label = escapeHtml(acct?.label || accountId);
  broadcastToAdmins(`✅ <b>WhatsApp Connected</b>\n\nAccount: <code>${label}</code>\nPhone: <code>${phoneNumber || 'unknown'}</code>`);
}

function broadcastToAdmins(msg) {
  const admins = db.getAdmins();
  const targets = new Set(admins.map(u => u.telegram_id));
  if (config.OWNER_ID) targets.add(config.OWNER_ID);
  (config.ADMIN_IDS || []).forEach(id => targets.add(id));
  for (const id of targets) {
    bot.sendMessage(id, msg, { parse_mode: 'HTML' }).catch(() => {});
  }
}

// ========== HELPERS ==========
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function escapeHtml(input) {
  return String(input ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatProgress({ done, total, startedAt, accountCount = 1 }) {
  const pct = total === 0 ? 0 : Math.floor((done / total) * 100);
  const barLen = 16;
  const filled = Math.round((pct / 100) * barLen);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barLen - filled));
  const elapsedMs = Date.now() - startedAt;
  const rate = done > 0 ? elapsedMs / done : null;
  const remainingMs = rate ? rate * (total - done) : null;
  const etaSec = remainingMs ? Math.max(0, Math.round(remainingMs / 1000)) : null;
  const acctLine = accountCount > 1 ? `\n🔀 <b>${accountCount} accounts</b> parallel checking` : '';
  return `⏳ <b>Checking...</b> ${done}/${total}\n<code>${bar}</code> ${pct}%${etaSec !== null ? `\n⏱️ ETA: ~${etaSec}s` : ''}${acctLine}`;
}

// ========== TELEGRAM BOT SETUP ==========
const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, {
  polling: { autoStart: true, interval: 1000, params: { timeout: 10 } },
});
bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});

let pollingResetInFlight = false;
bot.on('polling_error', async (err) => {
  const msg = err?.message || String(err);
  if (msg.includes('409 Conflict')) {
    if (pollingResetInFlight) return;
    pollingResetInFlight = true;
    try { await bot.stopPolling({ cancel: true }); } catch (_) {}
    setTimeout(async () => {
      try { await bot.startPolling(); } catch (_) {}
      finally { setTimeout(() => { pollingResetInFlight = false; }, 10_000); }
    }, 5_000);
    return;
  }
  logger.error({ err: msg }, 'Telegram polling error');
});
async function shutdown() {
  try { await bot.stopPolling({ cancel: true }); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ========== STATE ==========
const userStates = new Map();

// ========== AUTH ==========
function isAuthorized(userId, role = 'user') {
  if (userId === config.OWNER_ID) return true;
  if (config.ADMIN_IDS?.includes(userId)) return true;
  const user = db.getUser(userId);
  if (!user || user.is_blocked) return false;
  if (role === 'admin') return user.role === 'admin' || user.role === 'owner';
  const paidMode = db.getSetting('paid_mode') === 'true';
  if (paidMode) {
    if (!user.expires_at) return false;
    if (new Date(user.expires_at) < new Date()) return false;
  }
  const botMode = db.getSetting('bot_mode') || 'public';
  if (botMode === 'private') return user.role !== 'user' || !!user.is_allowed;
  return true;
}

function ensureOwner(userId, username) {
  const users = db.getAllUsers();
  if (users.length === 0) { db.createUser(userId, username, 'owner'); return true; }
  db.createUser(userId, username);
  return false;
}

async function checkForceSub(userId) {
  const ch = db.getSetting('fsub_channel');
  if (!ch) return true;
  try {
    const member = await bot.getChatMember(ch, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (_) { return true; }
}

// ========== KEYBOARDS ==========
const getMainMenuKeyboard = (userId) => {
  const isAdmin = isAuthorized(userId, 'admin');
  const keyboard = [
    [{ text: '📞 Check Number', callback_data: 'check_number' }],
    [{ text: '📁 Bulk Check (File)', callback_data: 'bulk_check' }],
    [{ text: '🎲 Get Number', callback_data: 'get_number' }, { text: '📤 Upload', callback_data: 'upload_mode' }],
    [{ text: '📊 Status', callback_data: 'status' }, { text: '📈 Stats', callback_data: 'stats' }],
  ];
  if (isAdmin) {
    keyboard.push([{ text: '👥 Users', callback_data: 'users' }, { text: '🔄 Toggle Bot', callback_data: 'toggle_bot' }]);
    keyboard.push([{ text: '📱 WA Accounts', callback_data: 'wa_accounts' }, { text: '➕ Add Account', callback_data: 'wa_add' }]);
    keyboard.push([{ text: '💎 Paid Mode', callback_data: 'paid_mode' }, { text: '📢 Force Sub', callback_data: 'force_sub' }]);
    keyboard.push([{ text: '⚙️ Limit', callback_data: 'set_limit' }]);
  }
  return { inline_keyboard: keyboard };
};

const getBackButton = () => ({ inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'main_menu' }]] });

function getWelcomeMessage(username, isNew) {
  const active = getConnectedAccounts();
  const waStatus = active.length > 0 ? `🟢 ${active.length} account(s) connected` : '🔴 No WhatsApp connected';
  return `👋 <b>Welcome to WhatsApp Number Checker!</b>\n\n${waStatus}\n\n📱 <b>How to use:</b>\n• Single number: <code>+1234567890</code>\n• Multiple numbers (one per line)\n• Upload <code>.txt</code> file for bulk check\n\n👤 Owner: <b>Dhairya Bhardwaj</b>\n📞 Contact: @Bhardwa_j${isNew ? '\n\n👑 <b>You are now the OWNER!</b>' : ''}\n\nUse buttons below:`;
}

// ========== START ==========
bot.onText(/\/start/, async (msg) => {
  const { id: chatId } = msg.chat;
  const { id: userId, username, first_name } = msg.from;
  const isNew = ensureOwner(userId, username || first_name);
  const isMember = await checkForceSub(userId);
  if (!isMember) {
    const ch = db.getSetting('fsub_channel');
    return bot.sendMessage(chatId, `❌ <b>Access Denied</b>\n\nJoin our channel first:\n👉 ${escapeHtml(ch)}\n\nThen click /start again.`, { parse_mode: 'HTML' });
  }
  bot.sendMessage(chatId, getWelcomeMessage(username || first_name, isNew), { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard(userId) });
});

// ========== WA ACCOUNTS PANEL ==========
async function handleWaAccounts(chatId, messageId) {
  const all = db.getAllAccounts();

  if (all.length === 0) {
    return bot.editMessageText(`📱 <b>WhatsApp Accounts</b>\n\nKoi account nahi hai. Add Account se pehle ek add karo.`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '➕ Add Account', callback_data: 'wa_add' }], [{ text: '◀️ Back', callback_data: 'main_menu' }]] }
    });
  }

  let text = `📱 <b>WhatsApp Accounts (${all.length})</b>\n\n`;
  const keyboard = [];

  for (const acct of all) {
    const inMem = accounts.get(acct.account_id);
    const status = inMem?.status || (acct.is_connected ? 'connected' : (acct.is_enabled ? 'disconnected' : 'banned'));
    const emoji = { connected: '🟢', waiting_for_scan: '⏳', connecting: '🔄', banned: '🚫', disconnected: '🔴' }[status] || '🔴';
    const phone = acct.phone_number ? `+${acct.phone_number}` : 'Not paired';
    const disabled = !acct.is_enabled ? ' <i>[disabled]</i>' : '';
    text += `${emoji} <b>${escapeHtml(acct.label || acct.account_id)}</b>${disabled}\n`;
    text += `   📞 ${phone} | Checks: ${acct.total_checks} | Bans: ${acct.ban_count}\n\n`;

    const row = [];
    if (status !== 'connected') {
      row.push({ text: `🔌 Connect`, callback_data: `wa_connect_${acct.account_id}` });
      row.push({ text: `🔗 Pair`, callback_data: `wa_pair_code_${acct.account_id}` });
    } else {
      row.push({ text: `⏹ Disconnect`, callback_data: `wa_disconnect_${acct.account_id}` });
    }
    row.push({ text: `🗑️ Remove`, callback_data: `wa_remove_${acct.account_id}` });
    keyboard.push(row);
  }

  keyboard.push([{ text: '➕ Add Account', callback_data: 'wa_add' }, { text: '🔄 Refresh', callback_data: 'wa_accounts' }]);
  keyboard.push([{ text: '◀️ Back', callback_data: 'main_menu' }]);

  await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

// ========== CALLBACK HANDLER ==========
bot.on('callback_query', async (query) => {
  const { message, from, data: cbData, id: queryId } = query;
  const chatId = message.chat.id;
  const userId = from.id;
  const messageId = message.message_id;

  const isMember = await checkForceSub(userId);
  if (!isMember) {
    const ch = db.getSetting('fsub_channel');
    return bot.answerCallbackQuery(queryId, { text: `Join ${ch} first!`, show_alert: true });
  }

  try {
    // ===== Dynamic WA callbacks =====
    if (cbData.startsWith('wa_connect_')) {
      if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
      const accountId = cbData.replace('wa_connect_', '');
      await bot.answerCallbackQuery(queryId, { text: '⏳ Connecting...' });
      connectAccount(accountId); // non-blocking
      await sleep(1200);
      return handleWaAccounts(chatId, messageId);
    }

    if (cbData.startsWith('wa_disconnect_')) {
      if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
      const accountId = cbData.replace('wa_disconnect_', '');
      await disconnectAccount(accountId);
      await bot.answerCallbackQuery(queryId, { text: '✅ Disconnected!' });
      return handleWaAccounts(chatId, messageId);
    }

    if (cbData.startsWith('wa_remove_')) {
      if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
      const accountId = cbData.replace('wa_remove_', '');
      await disconnectAccount(accountId);
      accounts.delete(accountId);
      db.removeAccount(accountId);
      await bot.answerCallbackQuery(queryId, { text: '✅ Removed!' });
      return handleWaAccounts(chatId, messageId);
    }

    if (cbData.startsWith('wa_pair_code_')) {
      if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
      const accountId = cbData.replace('wa_pair_code_', '');
      userStates.set(userId, { mode: 'pair_wa_number', accountId });
      await bot.editMessageText(`🔗 *Pairing — ${escapeHtml(accountId)}*\n\nApna WhatsApp number bhejo:\n\nFormat: \`919876543210\``, {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getBackButton()
      });
      return bot.answerCallbackQuery(queryId);
    }

    // ===== Static callbacks =====
    switch (cbData) {
      case 'main_menu':
        await bot.editMessageText(getWelcomeMessage(from.username || from.first_name, false), {
          chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: getMainMenuKeyboard(userId)
        });
        userStates.delete(userId);
        break;

      case 'check_number':
        userStates.set(userId, { mode: 'check_single' });
        await bot.editMessageText(`📞 *Check Single Number*\n\nNumber bhejo:\n\nFormat: \`919876543210\` ya \`+919876543210\``, {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getBackButton()
        });
        break;

      case 'bulk_check':
        userStates.set(userId, { mode: 'bulk_check' });
        await bot.editMessageText(`📁 *Bulk Check*\n\n\`.txt\` file bhejo ya seedha numbers.\n\n📊 Limit: ${db.getSetting('batch_limit') || 100}`, {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getBackButton()
        });
        break;

      case 'get_number':    await handleGetNumber(chatId, userId, messageId); break;
      case 'change_number': await handleChangeNumber(chatId, userId, messageId); break;

      case 'upload_mode':
        userStates.set(userId, { mode: 'upload' });
        await bot.editMessageText(`📤 *Upload Mode*\n\nNumbers ya \`.txt\` file bhejo.\nPool mein save honge.`, {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getBackButton()
        });
        break;

      case 'status': await handleStatus(chatId, messageId); break;
      case 'stats':  await handleStats(chatId, userId, messageId); break;

      case 'users':
        if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
        await handleUsers(chatId, messageId);
        break;

      case 'toggle_bot':
        if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
        await handleToggleBot(chatId, messageId);
        break;

      case 'set_public':
      case 'set_private':
        if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
        db.setSetting('bot_mode', cbData === 'set_public' ? 'public' : 'private');
        await bot.answerCallbackQuery(queryId, { text: `✅ ${cbData === 'set_public' ? 'Public' : 'Private'} mode set!` });
        await handleToggleBot(chatId, messageId);
        break;

      case 'wa_accounts':
        if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
        await handleWaAccounts(chatId, messageId);
        break;

      case 'wa_add':
        if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
        userStates.set(userId, { mode: 'wa_add' });
        await bot.editMessageText(`➕ *Add WhatsApp Account*\n\nAccount ke liye naam bhejo.\nSirf lowercase letters, numbers, underscore.\n\nExample: \`account1\`, \`main\`, \`backup_wa\``, {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getBackButton()
        });
        break;

      case 'paid_mode':
        if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
        await handlePaidMode(chatId, messageId);
        break;
      case 'paid_on':
      case 'paid_off':
        if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
        db.setSetting('paid_mode', cbData === 'paid_on' ? 'true' : 'false');
        await bot.answerCallbackQuery(queryId, { text: `✅ Paid mode ${cbData === 'paid_on' ? 'enabled' : 'disabled'}!` });
        await handlePaidMode(chatId, messageId);
        break;

      case 'force_sub':
        if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
        await handleForceSub(chatId, messageId);
        break;
      case 'fsub_remove':
        if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
        db.setSetting('fsub_channel', '');
        await bot.answerCallbackQuery(queryId, { text: '✅ Removed!' });
        await handleForceSub(chatId, messageId);
        break;
      case 'fsub_set':
        if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
        userStates.set(userId, { mode: 'set_fsub' });
        await bot.editMessageText(`📢 *Force Subscribe*\n\nChannel username ya ID bhejo.\n\nFormat: \`@channelname\` ya \`-100xxxxxxxxxx\``, {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getBackButton()
        });
        break;

      case 'set_limit':
        if (!isAuthorized(userId, 'admin')) return bot.answerCallbackQuery(queryId, { text: '❌ Admin only!', show_alert: true });
        userStates.set(userId, { mode: 'set_limit' });
        await bot.editMessageText(`⚙️ *Batch Limit*\n\nCurrent: \`${db.getSetting('batch_limit') || 100}\`\n\nNaya limit bhejo (1-1000):`, {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getBackButton()
        });
        break;
    }

    bot.answerCallbackQuery(queryId);
  } catch (err) {
    logger.error('Callback error:', err);
    bot.answerCallbackQuery(queryId, { text: '❌ Error!' });
  }
});

// ========== HANDLER FUNCTIONS ==========
async function handleGetNumber(chatId, userId, messageId) {
  const number = db.getNextNumber(userId);
  if (!number) {
    return bot.editMessageText(`🎲 *Get Number*\n\n❌ Pool empty hai.\nUpload se pehle numbers add karo.`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getBackButton()
    });
  }
  const remaining = db.getNumberCount(userId);
  await bot.editMessageText(`🎲 *Your Number*\n\n📱 \`${number.phone_number}\`\n\n📊 Remaining: ${remaining}`, {
    chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🔄 Change', callback_data: 'change_number' }], [{ text: '◀️ Back', callback_data: 'main_menu' }]] }
  });
}

async function handleChangeNumber(chatId, userId, messageId) {
  const number = db.getNextNumber(userId);
  if (!number) {
    return bot.editMessageText(`🔄 *Change Number*\n\n❌ Koi number nahi bacha.`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getBackButton()
    });
  }
  const remaining = db.getNumberCount(userId);
  await bot.editMessageText(`🎲 *New Number*\n\n📱 \`${number.phone_number}\`\n\n📊 Remaining: ${remaining}`, {
    chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🔄 Change', callback_data: 'change_number' }], [{ text: '◀️ Back', callback_data: 'main_menu' }]] }
  });
}

async function handleStatus(chatId, messageId) {
  const all = db.getAllAccounts();
  let text = `📊 <b>WhatsApp Status</b>\n\n`;
  if (all.length === 0) {
    text += `Koi account nahi.\nAdmin panel se account add karo.`;
  } else {
    for (const acct of all) {
      const inMem = accounts.get(acct.account_id);
      const status = inMem?.status || (acct.is_connected ? 'connected' : (acct.is_enabled ? 'disconnected' : 'banned'));
      const emoji = { connected: '🟢', waiting_for_scan: '⏳', connecting: '🔄', banned: '🚫', disconnected: '🔴' }[status] || '🔴';
      text += `${emoji} <b>${escapeHtml(acct.label || acct.account_id)}</b>\n`;
      text += `   📞 ${acct.phone_number ? '+' + acct.phone_number : 'Not paired'} | <code>${status}</code>\n\n`;
    }
  }
  const active = getConnectedAccounts();
  text += `✅ Active: <b>${active.length}</b> account(s) ready for checking`;
  await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: getBackButton() });
}

async function handleStats(chatId, userId, messageId) {
  const stats = db.getTotalStats();
  const users = db.getAllUsers();
  const userStats = db.getUserStats(userId);
  const active = getConnectedAccounts();
  const allAccounts = db.getAllAccounts();

  let acctStats = '';
  for (const acct of allAccounts) {
    const st = accounts.get(acct.account_id)?.status || 'disconnected';
    const emoji = st === 'connected' ? '🟢' : st === 'banned' ? '🚫' : '🔴';
    acctStats += `${emoji} ${escapeHtml(acct.label || acct.account_id)}: ${acct.total_checks} checks\n`;
  }

  await bot.editMessageText(`📈 *Statistics*\n\n*Global:*\n👥 Users: ${users.length}\n📱 Checked: ${stats?.total_checks || 0}\n✅ Registered: ${stats?.registered_count || 0}\n❌ Not Registered: ${stats?.not_registered_count || 0}\n\n*WA Accounts (${active.length} active):*\n${acctStats}\n*Your Stats:*\n📱 Your Checks: ${userStats?.total_checks || 0}`, {
    chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getBackButton()
  });
}

async function handleUsers(chatId, messageId) {
  const users = db.getAllUsers();
  if (!users.length) return bot.editMessageText('No users yet.', { chat_id: chatId, message_id: messageId, reply_markup: getBackButton() });
  let text = `👥 *Users (${users.length})*\n\n`;
  users.slice(0, 20).forEach(u => {
    const re = u.role === 'owner' ? '👑' : u.role === 'admin' ? '⭐' : '👤';
    const be = u.is_blocked ? '🚫' : '';
    text += `${re}${be} \`${u.telegram_id}\` - @${u.username || 'unknown'}\n`;
  });
  if (users.length > 20) text += `\n... and ${users.length - 20} more`;
  text += `\n\n/block <id> | /unblock <id>\n/promote <id> | /demote <id>\n/access grant <id> <days>`;
  await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getBackButton() });
}

async function handleToggleBot(chatId, messageId) {
  const mode = db.getSetting('bot_mode') || 'public';
  await bot.editMessageText(`🔄 *Bot Mode*\n\nCurrent: *${mode.toUpperCase()}*\n\n• Public: Sab use kar sakte hain\n• Private: Sirf allowed users`, {
    chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: mode === 'public' ? '✅ Public' : '⬜ Public', callback_data: 'set_public' }, { text: mode === 'private' ? '✅ Private' : '⬜ Private', callback_data: 'set_private' }],
      [{ text: '◀️ Back', callback_data: 'main_menu' }]
    ]}
  });
}

async function handlePaidMode(chatId, messageId) {
  const isPaid = db.getSetting('paid_mode') === 'true';
  await bot.editMessageText(`💎 *Paid Mode*\n\nStatus: *${isPaid ? 'ON' : 'OFF'}*\n\nON hone pe users ko subscription chahiye.\n\n/access grant <id> <days>`, {
    chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: isPaid ? '✅ ON' : '⬜ ON', callback_data: 'paid_on' }, { text: !isPaid ? '✅ OFF' : '⬜ OFF', callback_data: 'paid_off' }],
      [{ text: '◀️ Back', callback_data: 'main_menu' }]
    ]}
  });
}

async function handleForceSub(chatId, messageId) {
  const ch = db.getSetting('fsub_channel') || 'Not set';
  await bot.editMessageText(`📢 *Force Subscribe*\n\nCurrent: \`${ch}\``, {
    chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '➕ Set Channel', callback_data: 'fsub_set' }, { text: '❌ Remove', callback_data: 'fsub_remove' }],
      [{ text: '◀️ Back', callback_data: 'main_menu' }]
    ]}
  });
}

// ========== TEXT MESSAGE HANDLER ==========
bot.on('message', async (msg) => {
  const { id: chatId } = msg.chat;
  const { id: userId, username, first_name } = msg.from;
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  ensureOwner(userId, username || first_name);

  const isMember = await checkForceSub(userId);
  if (!isMember) {
    const ch = db.getSetting('fsub_channel');
    return bot.sendMessage(chatId, `❌ Join ${ch} first, then /start`);
  }

  if (!isAuthorized(userId)) {
    if (config.OWNER_ID) {
      const u = escapeHtml(username || first_name || 'unknown');
      bot.sendMessage(config.OWNER_ID, `⚠️ <b>Unauthorized</b>\n\nUser: @${u}\nID: <code>${userId}</code>`, { parse_mode: 'HTML' }).catch(() => {});
    }
    return bot.sendMessage(chatId, '❌ Not authorized. Contact @Bhardwa_j');
  }

  const userState = userStates.get(userId);

  // ===== wa_add: account naam =====
  if (userState?.mode === 'wa_add') {
    const accountId = text.trim().replace(/\s+/g, '_').toLowerCase();
    if (!/^[a-z0-9_]+$/.test(accountId)) {
      return bot.sendMessage(chatId, '❌ Sirf lowercase letters, numbers, underscore use karo. e.g. account1');
    }
    if (db.getAccount(accountId)) {
      userStates.delete(userId);
      return bot.sendMessage(chatId, `❌ <code>${escapeHtml(accountId)}</code> pehle se exist karta hai.`, { parse_mode: 'HTML' });
    }
    db.addAccount(accountId, accountId);
    accounts.set(accountId, { status: 'disconnected', sock: null, qrCode: null, retryCount: 0, retryTimer: null, phoneNumber: null });
    userStates.delete(userId);
    return bot.sendMessage(chatId, `✅ Account <b>${escapeHtml(accountId)}</b> add ho gaya!\n\nKaise connect karna hai?`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '📷 QR Code se', callback_data: `wa_connect_${accountId}` }],
        [{ text: '🔗 Pairing Code se', callback_data: `wa_pair_code_${accountId}` }],
        [{ text: '◀️ Back', callback_data: 'main_menu' }]
      ]}
    });
  }

  // ===== pair_wa_number: phone number =====
  if (userState?.mode === 'pair_wa_number') {
    const { accountId } = userState;
    userStates.delete(userId);
    const statusMsg = await bot.sendMessage(chatId, '⏳ Pairing code generate ho raha hai...');
    try {
      const code = await getPairingCode(accountId, text.trim());
      bot.editMessageText(`🔗 *Pairing Code*\n\nAccount: \`${escapeHtml(accountId)}\`\n\nCode: \`${code}\`\n\nWhatsApp → Settings → Linked Devices → Link a Device → Link with phone number`, {
        chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown', reply_markup: getBackButton()
      });
    } catch (err) {
      bot.editMessageText(`❌ Error: ${escapeHtml(err.message)}`, {
        chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML', reply_markup: getBackButton()
      });
    }
    return;
  }

  if (userState?.mode === 'set_fsub') {
    db.setSetting('fsub_channel', text.trim());
    userStates.delete(userId);
    return bot.sendMessage(chatId, `✅ Force subscribe channel set: ${escapeHtml(text.trim())}`, { reply_markup: getBackButton() });
  }

  if (userState?.mode === 'set_limit') {
    const limit = parseInt(text);
    if (isNaN(limit) || limit < 1 || limit > 1000) return bot.sendMessage(chatId, '❌ Valid number dalo (1-1000)');
    db.setSetting('batch_limit', limit.toString());
    userStates.delete(userId);
    return bot.sendMessage(chatId, `✅ Batch limit: ${limit}`, { reply_markup: getBackButton() });
  }

  if (userState?.mode === 'upload') {
    const numbers = text.split(/[\n,\s]+/).filter(n => /^\d{7,15}$/.test(n.replace(/[^\d]/g, '')));
    if (!numbers.length) return bot.sendMessage(chatId, '❌ No valid numbers found');
    for (const num of numbers) db.addNumber(userId, num.replace(/[^\d]/g, ''));
    return bot.sendMessage(chatId, `✅ Added ${numbers.length} numbers to your pool!`, { reply_markup: getBackButton() });
  }

  // ===== Default: check numbers =====
  if (!hasAnyConnected()) {
    return bot.sendMessage(chatId, '❌ Koi WhatsApp account connected nahi hai. Admin se contact karo.');
  }

  const numbers = text.split(/[\n,\s]+/).filter(n => /^\d{7,15}$/.test(n.replace(/[^\d]/g, '')));
  if (!numbers.length) return;

  const batchLimit = parseInt(db.getSetting('batch_limit')) || 100;
  if (numbers.length > batchLimit) return bot.sendMessage(chatId, `❌ Max ${batchLimit} numbers allowed`);

  await processNumbers(chatId, userId, numbers);
});

// ========== DOCUMENT HANDLER ==========
bot.on('document', async (msg) => {
  const { id: chatId } = msg.chat;
  const { id: userId, username, first_name } = msg.from;

  ensureOwner(userId, username || first_name);
  const isMember = await checkForceSub(userId);
  if (!isMember) return bot.sendMessage(chatId, '❌ Join the channel first!');
  if (!isAuthorized(userId)) return bot.sendMessage(chatId, '❌ Not authorized');
  if (!msg.document.file_name.endsWith('.txt')) return bot.sendMessage(chatId, '❌ .txt file bhejo');

  try {
    const file = await bot.getFile(msg.document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const text = await response.text();
    const numbers = text.split(/[\n,\s]+/).filter(n => /^\d{7,15}$/.test(n.replace(/[^\d]/g, '')));

    if (!numbers.length) return bot.sendMessage(chatId, '❌ No valid numbers in file');

    const userState = userStates.get(userId);
    if (userState?.mode === 'upload') {
      for (const num of numbers) db.addNumber(userId, num.replace(/[^\d]/g, ''));
      return bot.sendMessage(chatId, `✅ Added ${numbers.length} numbers to pool!`, { reply_markup: getBackButton() });
    }

    if (!hasAnyConnected()) return bot.sendMessage(chatId, '❌ Koi account connected nahi');
    const batchLimit = parseInt(db.getSetting('batch_limit')) || 100;
    if (numbers.length > batchLimit) return bot.sendMessage(chatId, `❌ Max ${batchLimit}. File has ${numbers.length}`);

    await processNumbers(chatId, userId, numbers, { alwaysSendTxt: true });
  } catch (err) {
    logger.error('File error:', err);
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// ========== PROCESS NUMBERS (Load Balanced) ==========
async function processNumbers(chatId, userId, numbers, options = {}) {
  const { alwaysSendTxt = false } = options;
  const startedAt = Date.now();
  const accountCount = getConnectedAccounts().length;

  const statusMsg = await bot.sendMessage(chatId, formatProgress({ done: 0, total: numbers.length, startedAt, accountCount }), { parse_mode: 'HTML' });

  let done = 0;
  let stopped = false;
  const progressTimer = setInterval(() => {
    if (stopped) return;
    bot.editMessageText(formatProgress({ done, total: numbers.length, startedAt, accountCount: getConnectedAccounts().length }), {
      chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML'
    }).catch(() => {});
  }, 3000);

  const results = await checkNumbersBalanced(numbers, (d) => { done = d; });

  stopped = true;
  clearInterval(progressTimer);

  const registered = results.filter(r => r?.is_registered === true);
  const notRegistered = results.filter(r => r?.is_registered === false);
  const unknown = results.filter(r => r?.is_registered === null);

  db.incrementStats(registered.length, notRegistered.length);
  db.incrementChecks(userId, numbers.length);

  const activeNow = getConnectedAccounts().length;
  const summaryLines = [
    `✅ <b>Results</b>`,
    ``,
    `📊 Total: <code>${numbers.length}</code>`,
    `✅ Registered: <code>${registered.length}</code>`,
    `❌ Not Registered: <code>${notRegistered.length}</code>`,
    `❓ Unknown: <code>${unknown.length}</code>`,
  ];
  if (accountCount > 1) summaryLines.push(`🔀 Used <b>${accountCount}</b> account(s) in parallel`);

  const shouldSendTxt = alwaysSendTxt || numbers.length > 50;

  if (shouldSendTxt) {
    const sendFile = async (arr, filename, caption) => {
      if (!arr.length) return;
      await bot.sendDocument(chatId, Buffer.from(arr.map(r => r.phone_number).join('\n'), 'utf-8'),
        { caption }, { filename, contentType: 'text/plain; charset=utf-8' }
      ).catch(() => {});
    };
    await sendFile(registered, 'registered.txt', `✅ ${registered.length} registered`);
    await sendFile(notRegistered, 'not_registered.txt', `❌ ${notRegistered.length} not registered`);
    await sendFile(unknown, 'unknown.txt', `❓ ${unknown.length} unknown`);
    summaryLines.push('', '📎 TXT files sent.');
  } else {
    const preview = (label, arr, icon) => {
      if (!arr.length) return;
      summaryLines.push('', `<b>${label}:</b>`);
      arr.slice(0, 30).forEach(r => summaryLines.push(`${icon} <code>${escapeHtml(r.phone_number)}</code>`));
      if (arr.length > 30) summaryLines.push(`... +${arr.length - 30} more`);
    };
    preview('Registered', registered, '✅');
    preview('Not Registered', notRegistered, '❌');
    preview('Unknown', unknown, '❓');
  }

  await bot.editMessageText(summaryLines.join('\n'), {
    chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML', reply_markup: getBackButton()
  }).catch(async () => {
    await bot.sendMessage(chatId, summaryLines.join('\n'), { parse_mode: 'HTML', reply_markup: getBackButton() }).catch(() => {});
  });
}

// ========== ADMIN COMMANDS ==========
bot.onText(/\/block (\d+)/, (msg, match) => {
  if (!isAuthorized(msg.from.id, 'admin')) return bot.sendMessage(msg.chat.id, '❌ Admin only');
  db.blockUser(parseInt(match[1]), true);
  bot.sendMessage(msg.chat.id, `✅ User ${match[1]} blocked`);
});
bot.onText(/\/unblock (\d+)/, (msg, match) => {
  if (!isAuthorized(msg.from.id, 'admin')) return bot.sendMessage(msg.chat.id, '❌ Admin only');
  db.blockUser(parseInt(match[1]), false);
  bot.sendMessage(msg.chat.id, `✅ User ${match[1]} unblocked`);
});
bot.onText(/\/promote (\d+)/, (msg, match) => {
  if (msg.from.id !== config.OWNER_ID) return bot.sendMessage(msg.chat.id, '❌ Owner only');
  db.updateUserRole(parseInt(match[1]), 'admin');
  bot.sendMessage(msg.chat.id, `✅ User ${match[1]} promoted to admin`);
});
bot.onText(/\/demote (\d+)/, (msg, match) => {
  if (msg.from.id !== config.OWNER_ID) return bot.sendMessage(msg.chat.id, '❌ Owner only');
  db.updateUserRole(parseInt(match[1]), 'user');
  bot.sendMessage(msg.chat.id, `✅ User ${match[1]} demoted`);
});
bot.onText(/\/access grant (\d+) (.+)/, (msg, match) => {
  if (!isAuthorized(msg.from.id, 'admin')) return bot.sendMessage(msg.chat.id, '❌ Admin only');
  const targetId = parseInt(match[1]);
  const duration = match[2].trim();
  let expiresAt = null;
  if (duration !== 'lifetime') {
    const days = parseInt(duration);
    if (isNaN(days)) return bot.sendMessage(msg.chat.id, '❌ Days ya "lifetime" dalo');
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);
  }
  db.grantAccess(targetId, expiresAt);
  const accessMsg = expiresAt ? `Access until ${expiresAt.toLocaleDateString()}` : 'Lifetime access';
  bot.sendMessage(msg.chat.id, `✅ User ${targetId}: ${accessMsg}`);
  bot.sendMessage(targetId, `🎉 *Access Granted!*\n\n${expiresAt ? `Expires: ${expiresAt.toLocaleDateString()}` : '✨ Lifetime!'}\n\nClick /start`, { parse_mode: 'Markdown' }).catch(() => {});
});

// ========== EXPRESS SERVER ==========
app.get('/', (_, res) => res.json({ status: 'running', bot: 'WhatsApp Checker Multi-Account' }));
app.get('/health', (_, res) => {
  const active = getConnectedAccounts();
  res.json({
    status: 'ok',
    connected_accounts: active.length,
    accounts: db.getAllAccounts().map(a => ({
      id: a.account_id, label: a.label, connected: !!a.is_connected, phone: a.phone_number, checks: a.total_checks
    }))
  });
});

const PORT = config.PORT || 3000;
app.listen(PORT, async () => {
  logger.info(`Server on port ${PORT}`);
  await connectAllSavedAccounts();
});

logger.info('Multi-account WhatsApp Bot started!');