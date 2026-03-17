// ════════════════════════════════════════════════════════════════════════════
//  WhatsApp Number Checker Bot  —  Professional Edition
//  Author: Dhairya Bhardwaj | @Bhardwa_j
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express    = require('express');
const TelegramBot = require('node-telegram-bot-api');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState, DisconnectReason,
  fetchLatestBaileysVersion, makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino   = require('pino');
const fs     = require('fs');
const path   = require('path');
const db     = require('./database');

// ─── CONFIG ─────────────────────────────────────────────────────────────────
let config;
try { config = require('./config'); } catch (_) { config = require('./config.example'); }

const logger = pino({ level: 'silent' });
const app    = express();
app.use(express.json());

// ─── SUPABASE ────────────────────────────────────────────────────────────────
let supabase = null;
if (config.SUPABASE_URL && config.SUPABASE_SERVICE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
}

// ─── DATA DIR ────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : (fs.existsSync('/var/data') ? '/var/data' : path.join(__dirname, 'data'));
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmt(n) { return Number(n || 0).toLocaleString(); }

function progressBar(done, total) {
  const pct  = total === 0 ? 0 : Math.floor((done / total) * 100);
  const fill = Math.round((pct / 100) * 16);
  return '▓'.repeat(fill) + '░'.repeat(16 - fill);
}

// ════════════════════════════════════════════════════════════════════════════
//  MULTI-ACCOUNT WHATSAPP ENGINE
// ════════════════════════════════════════════════════════════════════════════

// In-memory state: accountId → { sock, status, qrCode, retryCount, retryTimer, phoneNumber }
const accounts = new Map();

function getSessionDir(id) { return path.join(DATA_DIR, 'wa_' + id); }

function getConnectedCheckers() {
  const res = [];
  for (const [id, s] of accounts) {
    if (s.status === 'connected' && s.sock && s.accountType === 'checker') res.push({ id, ...s });
  }
  return res;
}

function hasAnyChecker() { return getConnectedCheckers().length > 0; }

// ─── SUPABASE SESSION PERSISTENCE ─────────────────────────────────────────
async function saveSession(accountId) {
  if (!supabase) return;
  const dir = getSessionDir(accountId);
  try {
    if (!fs.existsSync(dir)) return;
    const data = {};
    for (const f of fs.readdirSync(dir)) data[f] = fs.readFileSync(path.join(dir, f), 'utf-8');
    await supabase.from('whatsapp_sessions').upsert({
      session_id:   accountId,
      session_data: data,
      is_connected: accounts.get(accountId)?.status === 'connected',
      phone_number: accounts.get(accountId)?.phoneNumber || null,
      updated_at:   new Date().toISOString()
    }, { onConflict: 'session_id' });
  } catch (_) {}
}

async function loadSession(accountId) {
  if (!supabase) return false;
  const dir = getSessionDir(accountId);
  try {
    const { data } = await supabase.from('whatsapp_sessions')
      .select('session_data').eq('session_id', accountId).single();
    if (data?.session_data && Object.keys(data.session_data).length > 0) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      for (const [f, c] of Object.entries(data.session_data))
        fs.writeFileSync(path.join(dir, f), c);
      return true;
    }
  } catch (_) {}
  return false;
}

async function wipeSession(accountId) {
  const dir = getSessionDir(accountId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  db.setAccountConnected(accountId, false);
  if (supabase) {
    try {
      await supabase.from('whatsapp_sessions')
        .update({ session_data: {}, is_connected: false, updated_at: new Date().toISOString() })
        .eq('session_id', accountId);
    } catch (_) {}
  }
}

// ─── CONNECT ONE ACCOUNT ──────────────────────────────────────────────────
const MAX_RETRY = 50;

async function connectAccount(accountId, accountType = 'checker') {
  if (accounts.get(accountId)?.status === 'connected') return;

  db.addAccount(accountId, accountId, accountType);
  const dbAcct = db.getAccount(accountId);
  const type   = dbAcct?.account_type || accountType;

  if (!accounts.has(accountId)) {
    accounts.set(accountId, { status: 'connecting', sock: null, qrCode: null, retryCount: 0, retryTimer: null, phoneNumber: null, accountType: type });
  } else {
    Object.assign(accounts.get(accountId), { status: 'connecting', qrCode: null, accountType: type });
  }

  await loadSession(accountId);

  const dir = getSessionDir(accountId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      printQRInTerminal:          false,
      browser:                    ['Ubuntu', 'Chrome', '20.0.04'],
      generateHighQualityLinkPreview: false,
      syncFullHistory:            false,
      markOnlineOnConnect:        false,
      keepAliveIntervalMs:        30_000,
      connectTimeoutMs:           60_000,
      defaultQueryTimeoutMs:      60_000,
    });

    accounts.get(accountId).sock = sock;

    sock.ev.on('creds.update', async () => {
      try { await saveCreds(); await saveSession(accountId); } catch (_) {}
    });

    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;
      const acct = accounts.get(accountId);
      if (!acct) return;

      if (qr) {
        acct.qrCode  = await QRCode.toDataURL(qr);
        acct.status  = 'waiting_for_scan';
      }

      if (connection === 'close') {
        const code     = lastDisconnect?.error?.output?.statusCode;
        const isBanned = code === DisconnectReason.loggedOut;

        acct.status = isBanned ? 'banned' : 'disconnected';
        acct.sock   = null;
        acct.qrCode = null;
        db.setAccountConnected(accountId, false);

        if (isBanned) {
          db.incrementBanCount(accountId);
          const msg = `🚫 <b>Account Banned</b>\n\nID: <code>${esc(accountId)}</code>\n\nAuto-disabled. Promoting backup account...`;
          sendLog(msg);
          broadcastOwner(msg);
          await wipeSession(accountId);
          await promoteBackupAccount();
          return;
        }

        // ✅ FIX: Auto-reconnect on disconnect — promotes backup if no checkers left
        if (type === 'checker' && getConnectedCheckers().length === 0) {
          sendLog(`⚠️ <b>Checker Disconnected</b>\n\nID: <code>${esc(accountId)}</code>\nNo checkers left — promoting backup...`);
          broadcastOwner(`⚠️ <b>Checker Disconnected</b>\n\nID: <code>${esc(accountId)}</code>\nNo checkers left — promoting backup...`);
          await promoteBackupAccount();
        }

        if (acct.retryCount < MAX_RETRY) {
          acct.retryCount++;
          const backoff = Math.min(30_000, 2_000 * acct.retryCount);
          acct.retryTimer = setTimeout(() => connectAccount(accountId, type), backoff);
        }
      }

      if (connection === 'open') {
        acct.status      = 'connected';
        acct.qrCode      = null;
        acct.retryCount  = 0;
        acct.phoneNumber = sock.user?.id?.split(':')[0] || null;
        db.setAccountConnected(accountId, true, acct.phoneNumber);
        await saveSession(accountId);
        const msg = `✅ <b>Account Connected</b>\n\nID: <code>${esc(accountId)}</code>\nPhone: <code>+${acct.phoneNumber}</code>\nType: <code>${type}</code>`;
        sendLog(msg);
        broadcastOwner(msg);
      }
    });

  } catch (err) {
    const acct = accounts.get(accountId);
    if (acct) acct.status = 'disconnected';
  }
}

// ─── PROMOTE BACKUP TO CHECKER ────────────────────────────────────────────
async function promoteBackupAccount() {
  const backups = db.getEnabledBackupAccounts();
  for (const b of backups) {
    const s = accounts.get(b.account_id);
    if (s?.status === 'connected') {
      db.setAccountType(b.account_id, 'checker');
      if (s) s.accountType = 'checker';
      const msg = `🔄 <b>Backup Promoted</b>\n\n<code>${esc(b.account_id)}</code> is now a checker account.`;
      sendLog(msg);
      broadcastOwner(msg);
      return;
    }
  }
  // Try connecting a disconnected backup
  for (const b of backups) {
    const s = accounts.get(b.account_id);
    if (!s || s.status !== 'connected') {
      db.setAccountType(b.account_id, 'checker');
      await connectAccount(b.account_id, 'checker');
      const msg = `🔄 <b>Backup Promoted & Connecting</b>\n\n<code>${esc(b.account_id)}</code>`;
      sendLog(msg);
      broadcastOwner(msg);
      return;
    }
  }
  const msg = `⚠️ <b>No backup accounts available!</b>\n\nPlease add a new WhatsApp account.`;
  sendLog(msg);
  broadcastOwner(msg);
}

// ─── CONNECT ALL SAVED ON BOOT ─────────────────────────────────────────────
// ✅ FIX: On restart — always try to reconnect all enabled accounts using saved sessions
async function connectAllSaved() {
  const saved = db.getAllAccounts();
  if (!saved.length) return;
  console.log(`[Boot] Restoring ${saved.length} saved WA account(s)...`);
  for (const a of saved) {
    if (!a.is_enabled) {
      accounts.set(a.account_id, {
        status: 'banned', sock: null, qrCode: null,
        retryCount: 0, retryTimer: null,
        phoneNumber: a.phone_number, accountType: a.account_type
      });
      continue;
    }
    const dir = getSessionDir(a.account_id);
    const hasLocalSession = fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
    const hasSupabase = !!supabase;

    if (hasLocalSession || hasSupabase) {
      // Has session data — attempt reconnect
      console.log(`[Boot] Connecting: ${a.account_id} (local=${hasLocalSession}, supabase=${hasSupabase})`);
      await connectAccount(a.account_id, a.account_type || 'checker');
    } else {
      // No session at all — mark disconnected, needs manual QR/pair
      accounts.set(a.account_id, {
        status: 'disconnected', sock: null, qrCode: null,
        retryCount: 0, retryTimer: null,
        phoneNumber: a.phone_number, accountType: a.account_type || 'checker'
      });
      console.log(`[Boot] No session for ${a.account_id} — needs QR/pair`);
    }
  }
}

// ─── DISCONNECT ───────────────────────────────────────────────────────────
async function disconnectAccount(accountId) {
  const a = accounts.get(accountId);
  if (a?.retryTimer) clearTimeout(a.retryTimer);
  if (a?.sock) { try { await a.sock.logout(); } catch (_) {} a.sock = null; }
  if (a) a.status = 'disconnected';
  await wipeSession(accountId);
  const msg = `🔌 <b>Account Disconnected</b>\n\nID: <code>${esc(accountId)}</code>`;
  sendLog(msg);
  broadcastOwner(msg);
}

// ─── CHECK ONE NUMBER ─────────────────────────────────────────────────────
async function checkNumber(accountId, phone) {
  const a = accounts.get(accountId);
  if (!a?.sock || a.status !== 'connected')
    return { phone_number: phone, is_registered: null, error: 'not_connected' };
  try {
    const num = phone.replace(/\D/g, '');
    const [r]  = await a.sock.onWhatsApp(`${num}@s.whatsapp.net`);
    db.incrementAccountChecks(accountId);
    return { phone_number: phone, is_registered: r?.exists === true };
  } catch (e) {
    return { phone_number: phone, is_registered: false, error: e.message };
  }
}

// ─── LOAD-BALANCED BULK CHECK ─────────────────────────────────────────────
async function bulkCheck(numbers, onProgress) {
  const results = new Array(numbers.length).fill(null);
  let pending   = numbers.map((num, idx) => ({ idx, num }));
  let done      = 0;

  while (pending.length > 0) {
    const checkers = getConnectedCheckers();
    if (!checkers.length) {
      await sleep(10_000);
      if (!getConnectedCheckers().length) {
        for (const { idx, num } of pending)
          results[idx] = { phone_number: num, is_registered: null, error: 'no_accounts' };
        break;
      }
      continue;
    }

    const chunks = distribute(pending, checkers);
    pending = [];

    const failed = await Promise.all(chunks.map(async ({ accountId, items }) => {
      const fail = [];
      for (const { idx, num } of items) {
        const a = accounts.get(accountId);
        if (!a || a.status !== 'connected') { fail.push({ idx, num }); continue; }
        results[idx] = await checkNumber(accountId, num);
        done++;
        if (onProgress) onProgress(done, numbers.length);
        await sleep(50);
      }
      return fail;
    }));

    for (const f of failed) for (const item of f) pending.push(item);
    if (pending.length) await sleep(2_000);
  }

  return results;
}

function distribute(items, checkers) {
  const chunks = checkers.map(c => ({ accountId: c.id, items: [] }));
  items.forEach((item, i) => chunks[i % chunks.length].items.push(item));
  return chunks.filter(c => c.items.length);
}

// ─── PAIRING CODE ─────────────────────────────────────────────────────────
async function getPairingCode(accountId, phone, accountType = 'checker') {
  await wipeSession(accountId);
  db.addAccount(accountId, accountId, accountType);

  accounts.set(accountId, { status: 'connecting', sock: null, qrCode: null, retryCount: 0, retryTimer: null, phoneNumber: null, accountType });

  const dir = getSessionDir(accountId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    browser:           ['Ubuntu', 'Chrome', '20.0.04'],
  });

  const acct = accounts.get(accountId);
  acct.sock  = sock;

  sock.ev.on('creds.update', async () => { await saveCreds(); await saveSession(accountId); });

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect } = update;
    const a = accounts.get(accountId);
    if (!a) return;
    if (connection === 'open') {
      a.status      = 'connected';
      a.phoneNumber = sock.user?.id?.split(':')[0] || null;
      db.setAccountConnected(accountId, true, a.phoneNumber);
      await saveSession(accountId);
      const msg = `✅ <b>Account Paired & Connected</b>\n\nID: <code>${esc(accountId)}</code>\nPhone: <code>+${a.phoneNumber}</code>\nType: <code>${accountType}</code>`;
      sendLog(msg);
      broadcastOwner(msg);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        db.incrementBanCount(accountId);
        if (a) a.status = 'banned';
        const msg = `🚫 <b>Account Banned (Pairing)</b>\n\nID: <code>${esc(accountId)}</code>`;
        sendLog(msg);
        broadcastOwner(msg);
      } else if (a) {
        a.status = 'disconnected';
        a.sock   = null;
        if (a.retryCount < MAX_RETRY) {
          a.retryCount++;
          const backoff = Math.min(30_000, 2_000 * a.retryCount);
          a.retryTimer  = setTimeout(() => connectAccount(accountId, accountType), backoff);
        }
      }
    }
  });

  await sleep(3000);
  const formatted = phone.replace(/\D/g, '');
  const code      = await sock.requestPairingCode(formatted);
  return code;
}

// ════════════════════════════════════════════════════════════════════════════
//  TELEGRAM BOT
// ════════════════════════════════════════════════════════════════════════════

const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, {
  polling: { autoStart: true, interval: 1000, params: { timeout: 10 } },
});
bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});

// Dedup set — prevents same message being processed by both onText and on('message')
const _processedMsgIds = new Set();
function markMsg(id) {
  _processedMsgIds.add(id);
  // cleanup after 10s to avoid memory leak
  setTimeout(() => _processedMsgIds.delete(id), 10_000);
}
function alreadyHandled(id) { return _processedMsgIds.has(id); }

let pollingResetInFlight = false;
bot.on('polling_error', async err => {
  const m = err?.message || String(err);
  if (m.includes('409')) {
    if (pollingResetInFlight) return;
    pollingResetInFlight = true;
    try { await bot.stopPolling({ cancel: true }); } catch (_) {}
    setTimeout(async () => {
      try { await bot.startPolling(); } catch (_) {}
      finally { setTimeout(() => { pollingResetInFlight = false; }, 10_000); }
    }, 5_000);
  }
});
process.on('SIGTERM', async () => { try { await bot.stopPolling({ cancel: true }); } catch (_) {} process.exit(0); });
process.on('SIGINT',  async () => { try { await bot.stopPolling({ cancel: true }); } catch (_) {} process.exit(0); });

// ✅ FIX: userId → { mode, ... } — also store msgId to know which button was pressed
const userStates = new Map();

// ─── LOG GROUP ────────────────────────────────────────────────────────────
function sendLog(text) {
  const logGroup = config.LOG_GROUP_ID || db.getSetting('log_group_id');
  if (!logGroup || logGroup === '0' || logGroup === 0) return;
  bot.sendMessage(logGroup, text, { parse_mode: 'HTML' }).catch(() => {});
}

function logEvent(userId, username, action, detail = '') {
  const u = esc(username || userId);
  sendLog(`📋 <b>${esc(action)}</b>\n👤 @${u} (<code>${userId}</code>)\n${detail ? `ℹ️ ${esc(detail)}` : ''}`);
}

// ─── OWNER BROADCAST ─────────────────────────────────────────────────────
// ✅ FIX: Send to owner only (not all admins) for account events
function broadcastOwner(text) {
  if (config.OWNER_ID && config.OWNER_ID !== 0) {
    bot.sendMessage(config.OWNER_ID, text, { parse_mode: 'HTML' }).catch(() => {});
  }
}

function broadcastAdmins(text) {
  const admins = db.getAdmins();
  const ids    = new Set([...admins.map(u => u.telegram_id)]);
  if (config.OWNER_ID) ids.add(config.OWNER_ID);
  (config.ADMIN_IDS || []).forEach(id => ids.add(id));
  for (const id of ids) bot.sendMessage(id, text, { parse_mode: 'HTML' }).catch(() => {});
}

// ─── AUTH ─────────────────────────────────────────────────────────────────
function isOwner(userId)  { return userId === config.OWNER_ID; }

function isAdmin(userId) {
  if (isOwner(userId)) return true;
  if ((config.ADMIN_IDS || []).includes(userId)) return true;
  const u = db.getUser(userId);
  return u?.role === 'admin' || u?.role === 'owner';
}

function isAuthorized(userId) {
  if (isAdmin(userId)) return true;
  const u = db.getUser(userId);
  if (!u || u.is_blocked) return false;
  const botMode = db.getSetting('bot_mode') || 'public';
  if (botMode === 'private') return u.role !== 'user' || !!u.is_allowed;
  return true;
}

function isPremium(userId) {
  if (isAdmin(userId)) return true;
  return db.isPremiumActive(userId);
}

function isMaintenanceMode() {
  return db.getSetting('maintenance') === 'on';
}

// ─── KEYBOARDS ────────────────────────────────────────────────────────────
function mainMenu(userId) {
  const admin = isAdmin(userId);
  const kb = [
    [{ text: '🔍 Check Number', callback_data: 'check_number' }, { text: '📋 Bulk Check', callback_data: 'bulk_check' }],
    [{ text: '🧰 Tools', callback_data: 'tools' },              { text: '👤 My Profile', callback_data: 'profile' }],
    [{ text: '💎 Premium Plans', callback_data: 'premium_info' },{ text: '🎁 Referral', callback_data: 'referral' }],
    [{ text: '📡 Bot Status', callback_data: 'status' },         { text: '📖 Help', callback_data: 'help' }],
  ];
  if (admin) kb.push([{ text: '⚙️ Admin Panel', callback_data: 'owner_panel' }]);
  return { inline_keyboard: kb };
}

const backBtn = { inline_keyboard: [[{ text: '‹ Back to Menu', callback_data: 'main_menu' }]] };

// ─── WELCOME MESSAGE ──────────────────────────────────────────────────────
function welcomeText(userId) {
  const checkers = getConnectedCheckers();
  const statusLine = checkers.length
    ? `<b>🟢 Online</b> — <i>${checkers.length} checker account(s) active</i>`
    : `<b>🔴 Offline</b> — <i>No accounts connected</i>`;
  const u = db.getUser(userId);
  const name = u?.first_name ? ` ${esc(u.first_name)}` : '';
  const badge = u && db.isPremiumActive(u.telegram_id) ? '💎' : '👤';
  const tier  = u && db.isPremiumActive(u.telegram_id) ? '<b>Premium Member</b>' : '<b>Free User</b>';
  return (
    `╔══════════════════════╗\n` +
    `  🔍  <b>WA Number Checker</b>\n` +
    `╚══════════════════════╝\n\n` +
    `${badge} Hello${name}! — ${tier}\n` +
    `${statusLine}\n\n` +
    `<i>Instantly verify whether any phone number\nis registered on WhatsApp.</i>\n\n` +
    `<b>┌ Features</b>\n` +
    `<b>│</b> ✅ Single & Bulk number check\n` +
    `<b>│</b> ⚡ Fast load-balanced checking\n` +
    `<b>│</b> 📁 File upload support\n` +
    `<b>│</b> 🎁 Referral rewards\n` +
    `<b>└</b> 💎 Premium plans available\n\n` +
    `<i>Choose an option below to get started:</i>`
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  COMMANDS & CALLBACKS
// ════════════════════════════════════════════════════════════════════════════

// ─── /start ───────────────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId   = msg.chat.id;
  const userId   = msg.from.id;
  const username = msg.from.username || '';
  const firstName= msg.from.first_name || '';
  const refCode  = match?.[1]?.trim();

  if (isMaintenanceMode() && !isAdmin(userId)) {
    markMsg(msg.message_id);
    return bot.sendMessage(chatId,
      `🔧 <b>Maintenance Mode</b>\n\nThe bot is currently under maintenance. Please check back later.`,
      { parse_mode: 'HTML' });
  }

  const isNew = db.createUser(userId, username, firstName);

  if (isNew && refCode) {
    const referrer = db.getUserByReferCode(refCode);
    if (referrer && referrer.telegram_id !== userId) {
      const bonusChecks = parseInt(db.getSetting('refer_bonus') || '10');
      const applied = db.applyReferral(referrer.telegram_id, userId, bonusChecks);
      if (applied) {
        bot.sendMessage(referrer.telegram_id,
          `🎉 <b>New Referral!</b>\n\n@${esc(username) || userId} joined using your link.\nYou earned <b>+${bonusChecks}</b> bonus checks!`,
          { parse_mode: 'HTML' }).catch(() => {});
        // Log silently — no extra message to user
        sendLog(`🔗 <b>Referral Join</b>\n👤 @${esc(username)} (<code>${userId}</code>)\nReferred by: <code>${referrer.telegram_id}</code>`);
      }
    }
  }

  // Log new user silently to log group only — NOT to the chat
  if (isNew) {
    sendLog(`👋 <b>New User</b>\n👤 @${esc(username)} (<code>${userId}</code>)\nName: ${esc(firstName)}`);
  }

  const isMember = await checkForceSub(userId);
  if (!isMember) {
    const info = await getFsubChannelInfo();
    const linkText = info?.link || info?.id || '';
    const title    = info?.title || 'our channel';
    const fsub_img = db.getSetting('fsub_image') || null;
    markMsg(msg.message_id);

    const fsubText =
      `🔐 <b>Access Restricted</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `To use <b>WA Number Checker</b>, you must\n` +
      `first join our official channel.\n\n` +
      `📢 <b>Channel:</b> <a href="${esc(linkText)}">${esc(title)}</a>\n\n` +
      `<i>① Tap the button below to join\n` +
      `② Come back and click /start</i>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━`;

    const fsubKb = { inline_keyboard: [
      [{ text: `📢 Join — ${esc(title)}`, url: linkText }],
      [{ text: '✅ I have joined — Check Again', callback_data: 'fsub_verify' }],
    ]};

    if (fsub_img) {
      return bot.sendPhoto(chatId, fsub_img, {
        caption:      fsubText,
        parse_mode:   'HTML',
        reply_markup: fsubKb,
      }).catch(() =>
        bot.sendMessage(chatId, fsubText, { parse_mode: 'HTML', reply_markup: fsubKb })
      );
    }
    return bot.sendMessage(chatId, fsubText, { parse_mode: 'HTML', reply_markup: fsubKb });
  }

  // Clear any stale state on /start
  userStates.delete(userId);
  // Mark this message ID as handled so bot.on('message') ignores it
  markMsg(msg.message_id);
  return sendWelcome(chatId, userId);
});

// ─── FORCE SUBSCRIBE CHECK ─────────────────────────────────────────────────
// ✅ FIX: Fetch channel info — name + invite link automatically
async function checkForceSub(userId) {
  if (isAdmin(userId)) return true;
  const ch = db.getSetting('fsub_channel');
  if (!ch) return true;
  try {
    const m = await bot.getChatMember(ch, userId);
    return ['member','administrator','creator'].includes(m.status);
  } catch (_) { return true; }
}

// ✅ FIX: Get channel display name and invite link automatically
async function getFsubChannelInfo() {
  const ch = db.getSetting('fsub_channel');
  if (!ch) return null;
  try {
    const chat = await bot.getChat(ch);
    let inviteLink = chat.invite_link || null;
    // If no invite link stored, try to create/fetch one
    if (!inviteLink) {
      try { inviteLink = await bot.exportChatInviteLink(ch); } catch (_) {}
    }
    return {
      id: ch,
      title: chat.title || chat.username || ch,
      username: chat.username ? `@${chat.username}` : null,
      inviteLink,
      link: chat.username ? `https://t.me/${chat.username}` : inviteLink,
    };
  } catch (_) {
    return { id: ch, title: ch, username: null, inviteLink: null, link: ch };
  }
}

// ─── CALLBACK ROUTER ──────────────────────────────────────────────────────
bot.on('callback_query', async query => {
  const chatId    = query.message.chat.id;
  const userId    = query.from.id;
  const msgId     = query.message.message_id;
  const data      = query.data;
  const username  = query.from.username || '';

  // Answer callback ONCE — never call again below
  if (isMaintenanceMode() && !isAdmin(userId)) {
    await bot.answerCallbackQuery(query.id, { text: '🔧 Maintenance mode. Please wait.', show_alert: true }).catch(() => {});
    return;
  }

  const isMember = await checkForceSub(userId);
  if (!isMember) {
    const info = await getFsubChannelInfo();
    const title = info?.title || 'our channel';
    await bot.answerCallbackQuery(query.id, { text: `🔒 Please join ${title} first!`, show_alert: true }).catch(() => {});
    return;
  }

  // Ensure user exists in DB
  db.createUser(userId, query.from.username || '', query.from.first_name || '');

  // Authorization check
  if (!isAuthorized(userId)) {
    await bot.answerCallbackQuery(query.id, { text: '🔒 Access denied. Contact admin.', show_alert: true }).catch(() => {});
    return;
  }

  // Answer the callback — only once, here
  await bot.answerCallbackQuery(query.id).catch(() => {});

  // ── Dynamic callbacks ──
  if (data.startsWith('wa_qr_'))         return handleWaQR(chatId, userId, msgId, data.replace('wa_qr_',''));
  if (data.startsWith('wa_pair_'))       return handleWaPairPrompt(chatId, userId, msgId, data.replace('wa_pair_',''));
  if (data.startsWith('wa_dis_'))        return handleWaDisconnect(chatId, userId, msgId, data.replace('wa_dis_',''));
  if (data.startsWith('wa_del_'))        return handleWaDelete(chatId, userId, msgId, data.replace('wa_del_',''));
  if (data.startsWith('wa_type_ck_'))    return handleWaSetType(chatId, userId, msgId, data.replace('wa_type_ck_',''), 'checker');
  if (data.startsWith('wa_type_bk_'))    return handleWaSetType(chatId, userId, msgId, data.replace('wa_type_bk_',''), 'backup');
  if (data.startsWith('user_info_'))     return handleUserInfo(chatId, userId, msgId, parseInt(data.replace('user_info_','')));
  if (data.startsWith('user_ban_'))      return handleUserBan(chatId, userId, msgId, parseInt(data.replace('user_ban_','')), true);
  if (data.startsWith('user_unban_'))    return handleUserBan(chatId, userId, msgId, parseInt(data.replace('user_unban_','')), false);
  if (data.startsWith('user_promote_'))  return handleUserRole(chatId, userId, msgId, parseInt(data.replace('user_promote_','')), 'admin');
  if (data.startsWith('user_demote_'))   return handleUserRole(chatId, userId, msgId, parseInt(data.replace('user_demote_','')), 'user');
  if (data.startsWith('user_remprem_'))  return handleRemovePremium(chatId, userId, msgId, parseInt(data.replace('user_remprem_','')));
  if (data.startsWith('user_prem30_'))   return handleAddPremium(chatId, userId, msgId, parseInt(data.replace('user_prem30_','')), 30);
  if (data.startsWith('user_premlife_')) return handleAddPremium(chatId, userId, msgId, parseInt(data.replace('user_premlife_','')), 'lifetime');

  switch (data) {
    case 'main_menu':    return showMainMenu(chatId, userId, msgId);
    // ✅ FIX: Check Number & Bulk Check buttons now set state AND show instructions
    case 'check_number': return showCheckNumber(chatId, userId, msgId);
    case 'bulk_check':   return showBulkCheck(chatId, userId, msgId);
    case 'tools':        return showTools(chatId, userId, msgId);
    case 'profile':      return showProfile(chatId, userId, msgId);
    case 'premium_info': return showPremiumInfo(chatId, userId, msgId);
    case 'referral':     return showReferral(chatId, userId, msgId);
    case 'status':       return showStatus(chatId, userId, msgId);
    case 'help':         return showHelp(chatId, userId, msgId);
    case 'owner_panel':  return showOwnerPanel(chatId, userId, msgId);
    case 'export_profile': return handleExportProfile(chatId, userId);

    // Owner panel sub-menus
    case 'op_accounts':  return showWaAccounts(chatId, userId, msgId);
    case 'op_add_acct':  return startAddAccount(chatId, userId, msgId);
    case 'op_users':     return showUsersList(chatId, userId, msgId);
    case 'op_users_dl':  return handleUsersDownload(chatId, userId);
    case 'op_broadcast': return startBroadcast(chatId, userId, msgId);
    case 'op_fsub':      return showFsubSettings(chatId, userId, msgId);
    case 'op_settings':  return showBotSettings(chatId, userId, msgId);
    case 'op_stats':     return showDetailedStats(chatId, userId, msgId);
    case 'op_logs':      return setupLogGroup(chatId, userId, msgId);
    case 'fsub_verify':  return handleFsubVerify(query);

    // Settings toggles
    case 'set_public':
    case 'set_private':
      if (!isAdmin(userId)) return;
      db.setSetting('bot_mode', data === 'set_public' ? 'public' : 'private');
      return showBotSettings(chatId, userId, msgId);

    case 'maint_on':
    case 'maint_off':
      if (!isAdmin(userId)) return;
      db.setSetting('maintenance', data === 'maint_on' ? 'on' : 'off');
      return showBotSettings(chatId, userId, msgId);

    case 'paid_on':
    case 'paid_off':
      if (!isAdmin(userId)) return;
      db.setSetting('paid_mode', data === 'paid_on' ? 'true' : 'false');
      return showBotSettings(chatId, userId, msgId);

    case 'fsub_remove':
      if (!isAdmin(userId)) return;
      db.setSetting('fsub_channel', '');
      return showFsubSettings(chatId, userId, msgId);

    case 'fsub_img_remove':
      if (!isAdmin(userId)) return;
      db.setSetting('fsub_image', '');
      return showFsubSettings(chatId, userId, msgId);

    case 'set_fsub_image':
      if (!isAdmin(userId)) return;
      userStates.set(userId, { mode: 'set_fsub_image' });
      return editMsg(chatId, msgId,
        `🖼 <b>Set FSub Thumbnail</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Send a <b>photo</b> or paste a <b>direct image URL</b>.\n\n` +
        `<i>This image will appear with the "Join Channel" prompt.</i>`,
        backBtn);

    case 'set_fsub_input':
      if (!isAdmin(userId)) return;
      userStates.set(userId, { mode: 'set_fsub' });
      return editMsg(chatId, msgId,
        `📢 <b>Set Force Subscribe Channel</b>\n\nSend the channel username or ID:\n\n• Username: <code>@yourchannel</code>\n• ID: <code>-100xxxxxxxxxx</code>\n\nBot will automatically fetch the channel name and invite link.`,
        backBtn);

    case 'set_free_limit':
      if (!isAdmin(userId)) return;
      userStates.set(userId, { mode: 'set_free_limit' });
      return editMsg(chatId, msgId, `⚙️ <b>Set Free User Daily Limit</b>\n\nCurrent: <code>${db.getSetting('free_limit') || 20}</code>\n\nSend new limit (1-500):`, backBtn);

    case 'set_prem_limit':
      if (!isAdmin(userId)) return;
      userStates.set(userId, { mode: 'set_prem_limit' });
      return editMsg(chatId, msgId, `⚙️ <b>Set Premium User Daily Limit</b>\n\nCurrent: <code>${db.getSetting('prem_limit') || 500}</code>\n\nSend new limit (1-10000):`, backBtn);

    case 'set_bulk_limit':
      if (!isAdmin(userId)) return;
      userStates.set(userId, { mode: 'set_bulk_limit' });
      return editMsg(chatId, msgId, `⚙️ <b>Set Bulk Check Limit</b>\n\nCurrent: <code>${db.getSetting('bulk_limit') || 100}</code>\n\nSend new limit (1-5000):`, backBtn);

    case 'set_refer_bonus':
      if (!isAdmin(userId)) return;
      userStates.set(userId, { mode: 'set_refer_bonus' });
      return editMsg(chatId, msgId, `⚙️ <b>Set Referral Bonus Checks</b>\n\nCurrent: <code>${db.getSetting('refer_bonus') || 10}</code>\n\nSend new value:`, backBtn);

    case 'set_menu_image':
      if (!isAdmin(userId)) return;
      userStates.set(userId, { mode: 'set_menu_image' });
      return editMsg(chatId, msgId,
        `🖼 <b>Set Main Menu Image</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Send a <b>photo</b> or a <b>direct image URL</b>.\n\n` +
        `<i>This image appears with the main menu\nwhen users start the bot.</i>`,
        backBtn);

    case 'menu_img_remove':
      if (!isAdmin(userId)) return;
      db.setSetting('menu_image', '');
      return bot.sendMessage(chatId, `✅ Menu image removed.`, { parse_mode: 'HTML' }).then(() => showBotSettings(chatId, userId, msgId));

    case 'set_log_group':
      if (!isAdmin(userId)) return;
      userStates.set(userId, { mode: 'set_log_group' });
      return editMsg(chatId, msgId, `📋 <b>Set Log Group</b>\n\nSend the group/channel ID where all events will be logged:\n\n<code>-100xxxxxxxxxx</code>`, backBtn);

    case 'op_add_premium':
      if (!isAdmin(userId)) return;
      userStates.set(userId, { mode: 'add_premium_uid' });
      return editMsg(chatId, msgId, `💎 <b>Add Premium</b>\n\nSend the user's Telegram ID:`, backBtn);

    case 'tools_upload':
      userStates.set(userId, { mode: 'upload' });
      return editMsg(chatId, msgId,
        `📤 <b>Upload Numbers</b>\n\nSend numbers (one per line) or a <code>.txt</code> file.\nThey'll be saved to your personal pool.`,
        backBtn);

    case 'tools_get':
      return handleGetNumber(chatId, userId, msgId);

    case 'tools_change':
      return handleChangeNumber(chatId, userId, msgId);
  }
});

// ─── EDIT MESSAGE HELPER ──────────────────────────────────────────────────
async function editMsg(chatId, msgId, text, markup) {
  return bot.editMessageText(text, {
    chat_id:    chatId,
    message_id: msgId,
    parse_mode: 'HTML',
    reply_markup: markup,
    disable_web_page_preview: true,
  }).catch(() => {});
}

// ─── SEND WELCOME (with optional banner image) ───────────────────────────
async function sendWelcome(chatId, userId) {
  const img  = db.getSetting('menu_image') || null;
  const text = welcomeText(userId);
  const kb   = mainMenu(userId);
  if (img) {
    return bot.sendPhoto(chatId, img, {
      caption:      text,
      parse_mode:   'HTML',
      reply_markup: kb,
    }).catch(() => bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb }));
  }
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
}

async function showMainMenu(chatId, userId, msgId) {
  userStates.delete(userId);
  // Try to edit existing message first; if it fails (e.g. was a photo), send fresh
  const img = db.getSetting('menu_image') || null;
  if (img) {
    // Can't edit a text message into a photo — send new
    return sendWelcome(chatId, userId);
  }
  return editMsg(chatId, msgId, welcomeText(userId), mainMenu(userId));
}

// ─── CHECK NUMBER ─────────────────────────────────────────────────────────
async function showCheckNumber(chatId, userId, msgId) {
  userStates.set(userId, { mode: 'check_single' });
  return editMsg(chatId, msgId,
    `🔍 <b>Check Single Number</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Send a phone number to verify if it's\nregistered on WhatsApp.\n\n` +
    `<b>📌 Format Examples:</b>\n` +
    `  • <code>919876543210</code>  <i>(India)</i>\n` +
    `  • <code>14155552671</code>   <i>(USA)</i>\n` +
    `  • <code>+44 7911 123456</code>\n\n` +
    `<i>💡 Always include country code, no spaces needed.</i>`,
    backBtn);
}

// ─── BULK CHECK ───────────────────────────────────────────────────────────
async function showBulkCheck(chatId, userId, msgId) {
  const freeLimit = parseInt(db.getSetting('free_limit') || '20');
  const premLimit = parseInt(db.getSetting('prem_limit') || '500');
  const bulkLimit = parseInt(db.getSetting('bulk_limit') || '100');
  const isPrem    = isPremium(userId);
  const myLimit   = isPrem ? premLimit : freeLimit;
  const limits    = db.getRemainingChecks(userId, freeLimit, premLimit);
  userStates.set(userId, { mode: 'bulk_check' });
  return editMsg(chatId, msgId,
    `📋 <b>Bulk Number Check</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Send numbers <b>one per line</b> or upload a <b>.txt file</b>.\n\n` +
    `<b>📊 Your Quota:</b>\n` +
    `  • Daily limit: <code>${myLimit}</code> checks\n` +
    `  • Remaining today: <code>${limits.remaining}</code>\n` +
    `  • Per request max: <code>${bulkLimit}</code>\n` +
    `  • Tier: ${isPrem ? '<b>💎 Premium</b>' : '<b>👤 Free</b>'}\n\n` +
    `<i>Results for large batches (50+) are sent\nas downloadable .txt files.</i>`,
    backBtn);
}

// ─── TOOLS ────────────────────────────────────────────────────────────────
async function showTools(chatId, userId, msgId) {
  const count = db.getNumberCount(userId);
  return editMsg(chatId, msgId,
    `🧰 <b>Number Pool — Tools</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Upload a list of numbers and dispense them\none-by-one whenever you need.\n\n` +
    `<b>📦 Pool Status:</b>\n` +
    `  • Available numbers: <code>${count}</code>\n\n` +
    `<i>Great for managing number inventories\nwithout exposing them all at once.</i>`,
    { inline_keyboard: [
      [{ text: '📤 Upload Numbers', callback_data: 'tools_upload' }],
      [{ text: '🎲 Get Next Number', callback_data: 'tools_get' }, { text: '⏭ Skip / Next', callback_data: 'tools_change' }],
      [{ text: '‹ Back to Menu', callback_data: 'main_menu' }],
    ]});
}

// ─── PROFILE ──────────────────────────────────────────────────────────────
async function showProfile(chatId, userId, msgId) {
  const u = db.getUser(userId);
  if (!u) return;
  const today = new Date().toISOString().split('T')[0];
  const dailyUsed = u.daily_reset === today ? (u.daily_checks || 0) : 0;
  const freeLimit = parseInt(db.getSetting('free_limit')  || '20');
  const premLimit = parseInt(db.getSetting('prem_limit')  || '500');
  const isPrem    = isPremium(userId);
  const limit     = isPrem ? premLimit : freeLimit;
  let premText = '';
  if (isPrem) {
    if (!u.premium_until) premText = '\n💎 Premium: <b>Lifetime</b>';
    else {
      const d = new Date(u.premium_until);
      const diff = Math.ceil((d - new Date()) / 86400000);
      premText = `\n💎 Premium: <b>${diff} day(s) remaining</b> (expires ${d.toLocaleDateString()})`;
    }
  }
  const role  = u.role === 'owner' ? '👑 Owner' : u.role === 'admin' ? '⭐ Admin' : isPrem ? '💎 Premium' : '👤 Free';
  const joined = new Date(u.joined_at).toLocaleDateString();
  const kb = { inline_keyboard: [
    [{ text: '📄 Export My Data (.txt)', callback_data: 'export_profile' }],
    [{ text: '‹ Back to Menu', callback_data: 'main_menu' }],
  ]};
  return editMsg(chatId, msgId,
    `👤 <b>My Profile</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🆔 <b>ID:</b> <code>${userId}</code>\n` +
    `📛 <b>Username:</b> @${esc(u.username) || 'N/A'}\n` +
    `🎭 <b>Role:</b> ${role}${premText}\n\n` +
    `<b>📊 Statistics</b>\n` +
    `  ├ Total checks:  <b>${fmt(u.numbers_checked)}</b>\n` +
    `  ├ Today:         <b>${dailyUsed} / ${limit}</b>\n` +
    `  └ Bonus checks:  <b>${u.bonus_checks || 0}</b>\n\n` +
    `<b>🎁 Referral Program</b>\n` +
    `  ├ Your code:  <code>${u.refer_code || 'N/A'}</code>\n` +
    `  └ Referrals:  <b>${u.refer_count || 0}</b> friends joined\n\n` +
    `📅 <b>Joined:</b> <i>${joined}</i>`,
    kb);
}

// ─── PREMIUM INFO ─────────────────────────────────────────────────────────
async function showPremiumInfo(chatId, userId, msgId) {
  const isPrem = isPremium(userId);
  const u      = db.getUser(userId);
  const freeLimit = db.getSetting('free_limit')  || '20';
  const premLimit = db.getSetting('prem_limit')  || '500';
  const bulkLimit = db.getSetting('bulk_limit')  || '100';

  if (isPrem && u) {
    let expText = '';
    if (!u.premium_until) expText = '✨ <b>Lifetime Premium</b>';
    else {
      const d    = new Date(u.premium_until);
      const diff = Math.ceil((d - new Date()) / 86400000);
      expText = `⏳ <b>${diff} day(s) remaining</b>\n📅 Expires: ${d.toLocaleDateString()}`;
    }
    return editMsg(chatId, msgId,
      `💎 <b>Premium Status</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${expText}\n\n` +
      `<b>✨ Your Benefits:</b>\n` +
      `  ✅ <b>${premLimit}</b> checks per day\n` +
      `  ✅ Bulk up to <b>${bulkLimit}</b> numbers\n` +
      `  ✅ Priority processing\n` +
      `  ✅ Premium support\n\n` +
      `<i>Thank you for being a Premium member! 🙏</i>`,
      backBtn);
  }

  return editMsg(chatId, msgId,
    `💎 <b>Upgrade to Premium</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Compare Plans:</b>\n\n` +
    `<b>👤 Free</b>\n` +
    `  • ${freeLimit} checks / day\n` +
    `  • Basic features only\n\n` +
    `<b>💎 Premium</b>\n` +
    `  ✅ <b>${premLimit}</b> checks per day\n` +
    `  ✅ Bulk up to <b>${bulkLimit}</b> numbers\n` +
    `  ✅ Priority processing\n` +
    `  ✅ Dedicated support\n\n` +
    `<i>To purchase, contact the owner below:</i>`,
    { inline_keyboard: [
      [{ text: '👤 ⏤͟͞Dhairya Bhardwaj', url: 'https://t.me/bhardwa_j' }],
      [{ text: '‹ Back to Menu', callback_data: 'main_menu' }],
    ]});
}

// ─── REFERRAL ─────────────────────────────────────────────────────────────
async function showReferral(chatId, userId, msgId) {
  const u = db.getUser(userId);
  if (!u) return;
  const bonus   = parseInt(db.getSetting('refer_bonus') || '10');
  const botInfo = await bot.getMe();
  const link    = `https://t.me/${botInfo.username}?start=${u.refer_code}`;
  return editMsg(chatId, msgId,
    `🎁 <b>Referral Program</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Invite friends & earn <b>+${bonus} free checks</b>\nfor every person who joins!\n\n` +
    `<b>🔗 Your Referral Link:</b>\n` +
    `<code>${link}</code>\n\n` +
    `<b>📈 Your Stats:</b>\n` +
    `  ├ Friends referred: <b>${u.refer_count || 0}</b>\n` +
    `  └ Bonus earned:     <b>${u.bonus_checks || 0} checks</b>\n\n` +
    `<i>Share your link and watch your credits grow! 🚀</i>`,
    { inline_keyboard: [
      [{ text: '📤 Share Link', switch_inline_query: `Join using my link: ${link}` }],
      [{ text: '‹ Back to Menu', callback_data: 'main_menu' }],
    ]});
}

// ─── STATUS ───────────────────────────────────────────────────────────────
async function showStatus(chatId, userId, msgId) {
  const all = db.getAllAccounts();
  let body  = '';
  if (!all.length) {
    body = 'No WhatsApp accounts configured.';
  } else {
    for (const a of all) {
      const s   = accounts.get(a.account_id);
      const st  = s?.status || (a.is_connected ? 'connected' : a.is_enabled ? 'disconnected' : 'banned');
      const em  = { connected:'🟢', waiting_for_scan:'⏳', connecting:'🔄', banned:'🚫', disconnected:'🔴' }[st] || '🔴';
      const ph  = a.phone_number ? `+${a.phone_number}` : 'Not linked';
      const typ = a.account_type === 'backup' ? ' [backup]' : '';
      body += `${em} <b>${esc(a.label||a.account_id)}</b>${typ}\n`;
      body += `   📞 ${ph}\n\n`;
    }
  }
  const active = getConnectedCheckers().length;
  return editMsg(chatId, msgId,
    `📡 <b>System Status</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${body}` +
    `<b>━━━━━━━━━━━━━━━━━━━━</b>\n` +
    `✅ <b>Active checkers:</b> <code>${active}</code>`,
    backBtn);
}

// ─── HELP ─────────────────────────────────────────────────────────────────
async function showHelp(chatId, userId, msgId) {
  return editMsg(chatId, msgId,
    `📖 <b>Help & Guide</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>🔍 Check Number</b>\n` +
    `  Tap → send any number with country code\n` +
    `  <i>e.g. 919876543210</i>\n\n` +
    `<b>📋 Bulk Check</b>\n` +
    `  Tap → send numbers (one per line) or a .txt file\n` +
    `  <i>Results sent as file for 50+ numbers</i>\n\n` +
    `<b>🧰 Tools</b>\n` +
    `  Upload a number pool, dispense one-by-one\n\n` +
    `<b>💎 Premium</b>\n` +
    `  Higher daily limits + priority processing\n\n` +
    `<b>🎁 Referral</b>\n` +
    `  Share link → earn free bonus checks\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📞 <b>Need help? Contact support:</b>`,
    { inline_keyboard: [
      [{ text: '💬 Contact Support', url: 'https://t.me/bhardwa_j' }],
      [{ text: '‹ Back to Menu', callback_data: 'main_menu' }],
    ]});
}

// ─── OWNER PANEL ──────────────────────────────────────────────────────────
async function showOwnerPanel(chatId, userId, msgId) {
  if (!isAdmin(userId)) return;
  const totalUsers   = db.getAllUsers().length;
  const premUsers    = db.getAllUsers().filter(u => db.isPremiumActive(u.telegram_id)).length;
  const activeWA     = getConnectedCheckers().length;
  const maint        = isMaintenanceMode() ? '🔧 ON' : '✅ OFF';
  const paidMode     = db.getSetting('paid_mode') === 'true' ? '💰 ON' : '🆓 OFF';

  return editMsg(chatId, msgId,
    `⚙️ <b>Owner Panel</b>\n\n` +
    `👥 Total users: <b>${totalUsers}</b> | 💎 Premium: <b>${premUsers}</b>\n` +
    `📱 WA accounts online: <b>${activeWA}</b>\n` +
    `🔧 Maintenance: ${maint} | 💰 Paid Mode: ${paidMode}`,
    { inline_keyboard: [
      [{ text: '📱 WA Accounts', callback_data: 'op_accounts' }, { text: '➕ Add Account', callback_data: 'op_add_acct' }],
      [{ text: '👥 Users', callback_data: 'op_users' }, { text: '💎 Add Premium', callback_data: 'op_add_premium' }],
      [{ text: '📢 Broadcast', callback_data: 'op_broadcast' }, { text: '📋 Logs', callback_data: 'op_logs' }],
      [{ text: '📊 Stats', callback_data: 'op_stats' }, { text: '🔒 Force Sub', callback_data: 'op_fsub' }],
      [{ text: '⚙️ Settings', callback_data: 'op_settings' }],
      [{ text: '‹ Back to Menu', callback_data: 'main_menu' }],
    ]});
}

// ─── WA ACCOUNTS PANEL ────────────────────────────────────────────────────
async function showWaAccounts(chatId, userId, msgId) {
  if (!isAdmin(userId)) return;
  const all = db.getAllAccounts();
  let body  = all.length ? '' : 'No accounts added yet.\n\n';
  const kb  = [];

  for (const a of all) {
    const s   = accounts.get(a.account_id);
    const st  = s?.status || (a.is_connected ? 'connected' : a.is_enabled ? 'disconnected' : 'banned');
    const em  = { connected:'🟢', waiting_for_scan:'⏳', connecting:'🔄', banned:'🚫', disconnected:'🔴' }[st] || '🔴';
    const ph  = a.phone_number ? `+${a.phone_number}` : 'Not linked';
    const typ = a.account_type === 'backup' ? '🔒 Backup' : '✅ Checker';
    body += `${em} <b>${esc(a.label)}</b> — ${typ}\n`;
    body += `   📞 ${ph} | ✓ ${a.total_checks} | ⚠️ ${a.ban_count}\n\n`;

    const row = [];
    if (st !== 'connected') row.push({ text: `📷 QR`, callback_data: `wa_qr_${a.account_id}` });
    if (st !== 'connected') row.push({ text: `🔗 Pair`, callback_data: `wa_pair_${a.account_id}` });
    if (st === 'connected') row.push({ text: `⏹ Disconnect`, callback_data: `wa_dis_${a.account_id}` });
    if (a.account_type === 'checker') row.push({ text: `→ Backup`, callback_data: `wa_type_bk_${a.account_id}` });
    else row.push({ text: `→ Checker`, callback_data: `wa_type_ck_${a.account_id}` });
    row.push({ text: `🗑`, callback_data: `wa_del_${a.account_id}` });
    kb.push(row);
  }

  kb.push([{ text: '➕ Add Account', callback_data: 'op_add_acct' }, { text: '🔄 Refresh', callback_data: 'op_accounts' }]);
  kb.push([{ text: '‹ Back', callback_data: 'owner_panel' }]);

  return editMsg(chatId, msgId, `📱 <b>WhatsApp Accounts</b>\n\n${body}`, { inline_keyboard: kb });
}

// ─── WA QR CONNECT ────────────────────────────────────────────────────────
async function handleWaQR(chatId, userId, msgId, accountId) {
  if (!isAdmin(userId)) return;
  const statusMsg = await bot.sendMessage(chatId, `⏳ Generating QR code for <b>${esc(accountId)}</b>...`, { parse_mode: 'HTML' });
  logEvent(userId, '', 'WA Connect (QR)', accountId);

  connectAccount(accountId, db.getAccount(accountId)?.account_type || 'checker');

  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const a = accounts.get(accountId);
    if (a?.status === 'connected') {
      await bot.editMessageText(`✅ <b>${esc(accountId)}</b> is already connected!`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });
      return showWaAccounts(chatId, userId, msgId);
    }
    if (a?.qrCode) {
      const buf = Buffer.from(a.qrCode.split(',')[1], 'base64');
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      await bot.sendPhoto(chatId, buf, {
        caption: `📱 <b>Scan QR — ${esc(accountId)}</b>\n\nWhatsApp → Settings → Linked Devices → Link a Device\n\n⏳ Expires in ~60 seconds`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '‹ Back', callback_data: 'op_accounts' }]] }
      });
      return;
    }
  }
  await bot.editMessageText(`❌ Failed to generate QR. Please try again.`, { chat_id: chatId, message_id: statusMsg.message_id, reply_markup: backBtn });
}

// ─── WA PAIRING PROMPT ────────────────────────────────────────────────────
async function handleWaPairPrompt(chatId, userId, msgId, accountId) {
  if (!isAdmin(userId)) return;
  userStates.set(userId, { mode: 'pair_wa', accountId, accountType: db.getAccount(accountId)?.account_type || 'checker' });
  return editMsg(chatId, msgId,
    `🔗 <b>Pair via Phone — ${esc(accountId)}</b>\n\nSend your WhatsApp phone number:\n\nFormat: <code>919876543210</code> (with country code, no +)`,
    backBtn);
}

// ─── WA DISCONNECT ────────────────────────────────────────────────────────
async function handleWaDisconnect(chatId, userId, msgId, accountId) {
  if (!isAdmin(userId)) return;
  await disconnectAccount(accountId);
  logEvent(userId, '', 'WA Disconnected', accountId);
  return showWaAccounts(chatId, userId, msgId);
}

// ─── WA DELETE ────────────────────────────────────────────────────────────
async function handleWaDelete(chatId, userId, msgId, accountId) {
  if (!isAdmin(userId)) return;
  await disconnectAccount(accountId);
  accounts.delete(accountId);
  db.removeAccount(accountId);
  logEvent(userId, '', 'WA Account Removed', accountId);
  const msg = `🗑 <b>Account Deleted</b>\n\nID: <code>${esc(accountId)}</code>`;
  sendLog(msg);
  broadcastOwner(msg);
  return showWaAccounts(chatId, userId, msgId);
}

// ─── WA SET TYPE ──────────────────────────────────────────────────────────
async function handleWaSetType(chatId, userId, msgId, accountId, type) {
  if (!isAdmin(userId)) return;
  db.setAccountType(accountId, type);
  const s = accounts.get(accountId);
  if (s) s.accountType = type;
  const msg = `🔄 <b>Account Type Changed</b>\n\nID: <code>${esc(accountId)}</code>\nNew Type: <code>${type}</code>`;
  sendLog(msg);
  broadcastOwner(msg);
  return showWaAccounts(chatId, userId, msgId);
}

// ─── ADD ACCOUNT ──────────────────────────────────────────────────────────
async function startAddAccount(chatId, userId, msgId) {
  if (!isAdmin(userId)) return;
  userStates.set(userId, { mode: 'add_account' });
  return editMsg(chatId, msgId,
    `➕ <b>Add WhatsApp Account</b>\n\nSend a name for this account:\n\n• Lowercase letters, numbers, underscores only\n• Examples: <code>account1</code>, <code>main</code>, <code>backup_1</code>`,
    backBtn);
}

// ─── USERS LIST ───────────────────────────────────────────────────────────
async function showUsersList(chatId, userId, msgId) {
  if (!isAdmin(userId)) return;
  const allUsers = db.getAllUsers();
  const total    = allUsers.length;

  // Build user list text inline — NO separate buttons per user
  let lines = [`👥 <b>Users (${total} total)</b>\n`];
  for (const u of allUsers.slice(0, 50)) {
    const roleIcon = u.role === 'owner' ? '👑' : u.role === 'admin' ? '⭐' : db.isPremiumActive(u.telegram_id) ? '💎' : u.is_blocked ? '🚫' : '👤';
    const name = u.username ? `@${u.username}` : 'no_username';
    const prem = db.isPremiumActive(u.telegram_id) ? ' [P]' : '';
    const ban  = u.is_blocked ? ' [BAN]' : '';
    lines.push(`${roleIcon} <code>${u.telegram_id}</code> ${esc(name)}${prem}${ban}`);
  }
  if (total > 50) lines.push(`\n<i>...and ${total - 50} more</i>`);
  lines.push(`\n<i>Tap a user ID to manage: /user &lt;id&gt;</i>`);

  const kb = { inline_keyboard: [
    [
      { text: '📥 Download All (.txt)', callback_data: 'op_users_dl' },
      { text: '🔄 Refresh', callback_data: 'op_users' },
    ],
    [{ text: '‹ Back', callback_data: 'owner_panel' }],
  ]};

  await bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: kb,
  }).catch(() => {});
}

// ─── USERS DOWNLOAD ───────────────────────────────────────────────────────
async function handleUsersDownload(chatId, userId) {
  if (!isAdmin(userId)) return;
  const allUsers = db.getAllUsers();
  let txt = `WhatsApp Checker Bot — Users Export\n`;
  txt += `Total: ${allUsers.length} | Exported: ${new Date().toISOString()}\n`;
  txt += '='.repeat(60) + '\n\n';
  for (const u of allUsers) {
    const prem = db.isPremiumActive(u.telegram_id);
    txt += `ID:       ${u.telegram_id}\n`;
    txt += `Username: @${u.username || 'N/A'}\n`;
    txt += `Name:     ${u.first_name || 'N/A'}\n`;
    txt += `Role:     ${u.role}\n`;
    txt += `Premium:  ${prem ? (u.premium_until ? 'Yes until ' + u.premium_until : 'Lifetime') : 'No'}\n`;
    txt += `Banned:   ${u.is_blocked ? 'Yes' : 'No'}\n`;
    txt += `Checks:   ${u.numbers_checked || 0}\n`;
    txt += `Joined:   ${u.joined_at}\n`;
    txt += '-'.repeat(40) + '\n';
  }
  await bot.sendDocument(chatId,
    Buffer.from(txt, 'utf-8'),
    { caption: `📥 <b>All Users Export</b>\n${allUsers.length} users`, parse_mode: 'HTML' },
    { filename: `users_${Date.now()}.txt`, contentType: 'text/plain' }
  ).catch(() => {});
}

// ─── USER INFO ────────────────────────────────────────────────────────────
async function handleUserInfo(chatId, adminId, msgId, targetId) {
  if (!isAdmin(adminId)) return;
  const u = db.getUser(targetId);
  if (!u) {
    return bot.sendMessage(chatId, `❌ User not found.`, { parse_mode: 'HTML', reply_markup: backBtn });
  }

  const role    = u.role === 'owner' ? '👑 Owner' : u.role === 'admin' ? '⭐ Admin' : '👤 User';
  const prem    = db.isPremiumActive(targetId);
  const premTxt = prem
    ? (u.premium_until ? `✅ Active until ${new Date(u.premium_until).toLocaleDateString()}` : '✅ Lifetime')
    : '❌ None';

  // Row 1: Ban/Unban
  const banRow = u.is_blocked
    ? [{ text: '✅ Unban User', callback_data: `user_unban_${targetId}` }]
    : [{ text: '🚫 Ban User',   callback_data: `user_ban_${targetId}` }];

  // Row 2: Premium — add 30d / add lifetime / remove
  const premRow = prem
    ? [{ text: '❌ Remove Premium', callback_data: `user_remprem_${targetId}` }]
    : [
        { text: '💎 +30 Days',   callback_data: `user_prem30_${targetId}` },
        { text: '♾ Lifetime',    callback_data: `user_premlife_${targetId}` },
      ];

  // Row 3: Role
  const roleRow = u.role === 'admin'
    ? [{ text: '⬇️ Demote to User',     callback_data: `user_demote_${targetId}` }]
    : [{ text: '⬆️ Promote to Admin',   callback_data: `user_promote_${targetId}` }];

  const kb = { inline_keyboard: [
    banRow,
    premRow,
    roleRow,
    [{ text: '‹ Back to Users', callback_data: 'op_users' }],
  ]};

  const today = new Date().toISOString().split('T')[0];
  const dailyUsed = u.daily_reset === today ? (u.daily_checks || 0) : 0;

  const text =
    `👤 <b>User Details</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🆔 <b>ID:</b> <code>${targetId}</code>\n` +
    `📛 <b>Username:</b> @${esc(u.username) || 'N/A'}\n` +
    `👤 <b>Name:</b> ${esc(u.first_name || 'N/A')}\n` +
    `🎭 <b>Role:</b> ${role}\n\n` +
    `<b>💎 Premium:</b> ${premTxt}\n` +
    `<b>🚫 Banned:</b> ${u.is_blocked ? 'Yes' : 'No'}\n\n` +
    `<b>📊 Stats:</b>\n` +
    `  ├ Total checks: <b>${fmt(u.numbers_checked)}</b>\n` +
    `  ├ Today:        <b>${dailyUsed}</b>\n` +
    `  └ Bonus:        <b>${u.bonus_checks || 0}</b>\n\n` +
    `📅 <b>Joined:</b> <i>${new Date(u.joined_at).toLocaleDateString()}</i>`;

  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
}

async function handleUserBan(chatId, adminId, msgId, targetId, ban) {
  if (!isAdmin(adminId)) return;
  db.blockUser(targetId, ban);
  // Notify the user
  bot.sendMessage(targetId,
    ban
      ? `🚫 <b>You have been banned</b> from using this bot.\n\n<i>Contact support if you think this is a mistake.</i>`
      : `✅ <b>Your ban has been lifted.</b>\n\nYou can now use the bot again. Type /start`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
  sendLog(`${ban ? '🚫' : '✅'} <b>User ${ban ? 'Banned' : 'Unbanned'}</b>\n🆔 <code>${targetId}</code>\nBy: <code>${adminId}</code>`);
  return handleUserInfo(chatId, adminId, msgId, targetId);
}

async function handleUserRole(chatId, adminId, msgId, targetId, role) {
  if (!isOwner(adminId) && role === 'admin') return;
  db.updateRole(targetId, role);
  bot.sendMessage(targetId,
    role === 'admin'
      ? `⭐ <b>You have been promoted to Admin!</b>\n\nYou now have access to the Admin Panel.`
      : `👤 <b>Your admin role has been removed.</b>`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
  sendLog(`🎭 <b>User ${role === 'admin' ? 'Promoted to Admin' : 'Demoted'}</b>\n🆔 <code>${targetId}</code>\nBy: <code>${adminId}</code>`);
  return handleUserInfo(chatId, adminId, msgId, targetId);
}

async function handleRemovePremium(chatId, adminId, msgId, targetId) {
  if (!isAdmin(adminId)) return;
  db.removePremium(targetId);
  bot.sendMessage(targetId,
    `💔 <b>Your Premium has been removed.</b>\n\nYou are now on the Free plan.`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
  sendLog(`💎 <b>Premium Removed</b>\n🆔 <code>${targetId}</code>\nBy: <code>${adminId}</code>`);
  return handleUserInfo(chatId, adminId, msgId, targetId);
}

async function handleAddPremium(chatId, adminId, msgId, targetId, days) {
  if (!isAdmin(adminId)) return;
  let until = null;
  if (days !== 'lifetime') {
    until = new Date();
    until.setDate(until.getDate() + days);
  }
  db.createUser(targetId, '', '', 'user');
  db.setPremium(targetId, until);
  const expTxt = until ? `until ${until.toLocaleDateString()}` : 'Lifetime';
  bot.sendMessage(targetId,
    `💎 <b>Premium Activated!</b>\n\n` +
    `${until ? `Active until <b>${until.toLocaleDateString()}</b>` : '✨ You have <b>Lifetime Premium</b>!'}\n\n` +
    `Enjoy your benefits! 🎉`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
  sendLog(`💎 <b>Premium Added</b>\n🆔 <code>${targetId}</code>\n⏳ ${expTxt}\nBy: <code>${adminId}</code>`);
  return handleUserInfo(chatId, adminId, msgId, targetId);
}

// ─── BROADCAST ────────────────────────────────────────────────────────────
async function startBroadcast(chatId, userId, msgId) {
  if (!isAdmin(userId)) return;
  userStates.set(userId, { mode: 'broadcast' });
  return editMsg(chatId, msgId,
    `📢 <b>Broadcast Message</b>\n\nSend the message you want to broadcast to all users.\n\nSupports: HTML formatting, photos, documents.`,
    backBtn);
}

// ─── FORCE SUB SETTINGS ───────────────────────────────────────────────────
// ✅ FIX: Shows channel name and invite link automatically
async function showFsubSettings(chatId, userId, msgId) {
  if (!isAdmin(userId)) return;
  const ch      = db.getSetting('fsub_channel');
  const fsubImg = db.getSetting('fsub_image') || null;
  let body = `🔒 <b>Force Subscribe Settings</b>\n` +
             `━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (ch) {
    const info = await getFsubChannelInfo();
    body += `<b>📢 Channel:</b> ${info ? `<b>${esc(info.title)}</b>` : `<code>${esc(ch)}</code>`}\n`;
    if (info?.username) body += `<b>🔗 Handle:</b> ${esc(info.username)}\n`;
    if (info?.link)     body += `<b>📎 Link:</b> ${esc(info.link)}\n`;
    body += `<b>🆔 ID:</b> <code>${esc(ch)}</code>\n`;
  } else {
    body += `<i>No channel set — bot is open to all users.</i>\n`;
  }

  body += `\n<b>🖼 Thumbnail:</b> ${fsubImg ? '✅ Set' : '❌ Not set'}\n`;
  body += `<i>(Image shown with the join prompt)</i>`;

  const kb = { inline_keyboard: [
    [{ text: ch ? '✏️ Change Channel' : '➕ Set Channel', callback_data: 'set_fsub_input' },
     { text: '🖼 Set Image', callback_data: 'set_fsub_image' }],
    ch ? [{ text: '🗑 Remove Channel', callback_data: 'fsub_remove' }] : [],
    fsubImg ? [{ text: '🗑 Remove Image', callback_data: 'fsub_img_remove' }] : [],
    [{ text: '‹ Back', callback_data: 'owner_panel' }],
  ].filter(r => r.length)};

  return editMsg(chatId, msgId, body, kb);
}

// ─── BOT SETTINGS ─────────────────────────────────────────────────────────
async function showBotSettings(chatId, userId, msgId) {
  if (!isAdmin(userId)) return;
  const mode    = db.getSetting('bot_mode')   || 'public';
  const maint   = db.getSetting('maintenance')|| 'off';
  const paid    = db.getSetting('paid_mode')  || 'false';
  const freeL   = db.getSetting('free_limit') || '20';
  const premL   = db.getSetting('prem_limit') || '500';
  const bulkL   = db.getSetting('bulk_limit') || '100';
  const refB    = db.getSetting('refer_bonus')|| '10';
  const menuImg = db.getSetting('menu_image') || null;

  return editMsg(chatId, msgId,
    `⚙️ <b>Bot Settings</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🌐 <b>Mode:</b> <code>${mode}</code>\n` +
    `🔧 <b>Maintenance:</b> <code>${maint}</code>\n` +
    `💰 <b>Paid Mode:</b> <code>${paid}</code>\n` +
    `👤 <b>Free limit:</b> <code>${freeL}/day</code>\n` +
    `💎 <b>Premium limit:</b> <code>${premL}/day</code>\n` +
    `📁 <b>Bulk limit:</b> <code>${bulkL}</code>\n` +
    `🔗 <b>Refer bonus:</b> <code>${refB} checks</code>\n` +
    `🖼 <b>Menu image:</b> ${menuImg ? '✅ Set' : '❌ Not set'}`,
    { inline_keyboard: [
      [{ text: mode==='public'?'✅ Public':'⬜ Public', callback_data:'set_public' },
       { text: mode==='private'?'✅ Private':'⬜ Private', callback_data:'set_private' }],
      [{ text: maint==='on'?'✅ Maint ON':'⬜ Maint ON', callback_data:'maint_on' },
       { text: maint==='off'?'✅ Maint OFF':'⬜ Maint OFF', callback_data:'maint_off' }],
      [{ text: paid==='true'?'✅ Paid ON':'⬜ Paid ON', callback_data:'paid_on' },
       { text: paid!=='true'?'✅ Paid OFF':'⬜ Paid OFF', callback_data:'paid_off' }],
      [{ text: '👤 Free Limit', callback_data:'set_free_limit' },
       { text: '💎 Premium Limit', callback_data:'set_prem_limit' }],
      [{ text: '📁 Bulk Limit', callback_data:'set_bulk_limit' },
       { text: '🔗 Refer Bonus', callback_data:'set_refer_bonus' }],
      [{ text: menuImg ? '🖼 Change Menu Image' : '🖼 Set Menu Image', callback_data: 'set_menu_image' },
       menuImg ? { text: '🗑 Remove Menu Image', callback_data: 'menu_img_remove' } : { text: '‹ Back', callback_data: 'owner_panel' }],
      menuImg ? [{ text: '‹ Back', callback_data: 'owner_panel' }] : [],
    ].filter(r => Array.isArray(r) ? r.length : true)});
}

// ─── DETAILED STATS ───────────────────────────────────────────────────────
async function showDetailedStats(chatId, userId, msgId) {
  if (!isAdmin(userId)) return;
  const total  = db.getTotalStats();
  const users  = db.getAllUsers();
  const prems  = users.filter(u => db.isPremiumActive(u.telegram_id)).length;
  const admins = users.filter(u => u.role === 'admin').length;
  const hist   = db.getStatsHistory(7);
  const waAll  = db.getAllAccounts();
  let waStats  = '';
  for (const a of waAll) waStats += `• ${esc(a.label)}: ${a.total_checks} checks, ${a.ban_count} bans\n`;

  return editMsg(chatId, msgId,
    `📊 <b>Detailed Statistics</b>\n\n` +
    `👥 Users: <b>${users.length}</b> total | 💎 <b>${prems}</b> premium | ⭐ <b>${admins}</b> admin\n\n` +
    `📱 Total checks: <b>${fmt(total?.total_checks)}</b>\n` +
    `✅ Registered: <b>${fmt(total?.registered_count)}</b>\n` +
    `❌ Not registered: <b>${fmt(total?.not_registered_count)}</b>\n\n` +
    `📈 <b>Last 7 days:</b>\n${hist.map(d=>`• ${d.date}: ${d.total_checks} checks`).join('\n') || 'No data'}\n\n` +
    `📱 <b>WA Accounts:</b>\n${waStats || 'None'}`,
    { inline_keyboard: [[{ text: '‹ Back', callback_data: 'owner_panel' }]] });
}

// ─── LOG GROUP SETUP ──────────────────────────────────────────────────────
async function setupLogGroup(chatId, userId, msgId) {
  if (!isAdmin(userId)) return;
  const current = config.LOG_GROUP_ID || db.getSetting('log_group_id') || 'Not set';
  userStates.set(userId, { mode: 'set_log_group' });
  return editMsg(chatId, msgId,
    `📋 <b>Log Group Setup</b>\n\nCurrent: <code>${esc(current)}</code>\n\nAll bot events (joins, checks, errors) will be sent here.\nSend the group/channel ID:`,
    backBtn);
}

// ─── FSUB VERIFY BUTTON ──────────────────────────────────────────────────
async function handleFsubVerify(query) {
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const isMember = await checkForceSub(userId);
  if (isMember) {
    userStates.delete(userId);
    await bot.answerCallbackQuery(query.id, { text: '✅ Access granted!', show_alert: false }).catch(() => {});
    return sendWelcome(chatId, userId);
  } else {
    return bot.answerCallbackQuery(query.id, { text: '❌ You have not joined yet. Please join first!', show_alert: true }).catch(() => {});
  }
}

// ─── GET / CHANGE NUMBER ─────────────────────────────────────────────────
async function handleGetNumber(chatId, userId, msgId) {
  const n = db.getNextNumber(userId);
  if (!n) {
    return editMsg(chatId, msgId,
      `🎲 <b>Get Number</b>\n\n❌ Your pool is empty.\n\nUse <b>Upload Numbers</b> in Tools to add some.`,
      { inline_keyboard: [[{ text: '📤 Upload Numbers', callback_data: 'tools_upload' }], [{ text: '‹ Back', callback_data: 'tools' }]] });
  }
  const rem = db.getNumberCount(userId);
  return editMsg(chatId, msgId,
    `🎲 <b>Your Number</b>\n\n📱 <code>${n.phone_number}</code>\n\n📦 Remaining in pool: ${rem}`,
    { inline_keyboard: [
      [{ text: '🔄 Skip / Next', callback_data: 'tools_change' }],
      [{ text: '‹ Back to Tools', callback_data: 'tools' }],
    ]});
}

async function handleChangeNumber(chatId, userId, msgId) {
  const n = db.getNextNumber(userId);
  if (!n) {
    return editMsg(chatId, msgId,
      `🔄 <b>Skip Number</b>\n\n❌ No more numbers in pool.`,
      { inline_keyboard: [[{ text: '‹ Back', callback_data: 'tools' }]] });
  }
  const rem = db.getNumberCount(userId);
  return editMsg(chatId, msgId,
    `🎲 <b>Next Number</b>\n\n📱 <code>${n.phone_number}</code>\n\n📦 Remaining: ${rem}`,
    { inline_keyboard: [
      [{ text: '🔄 Skip / Next', callback_data: 'tools_change' }],
      [{ text: '‹ Back to Tools', callback_data: 'tools' }],
    ]});
}

// ─── PROFILE EXPORT ───────────────────────────────────────────────────────
async function handleExportProfile(chatId, userId) {
  const u = db.getUser(userId);
  if (!u) return;
  const prem = db.isPremiumActive(userId);
  const txt  =
    `WhatsApp Checker Bot — User Profile Export\n` +
    `==========================================\n` +
    `Exported: ${new Date().toISOString()}\n\n` +
    `ID:         ${u.telegram_id}\n` +
    `Username:   @${u.username || 'N/A'}\n` +
    `Name:       ${u.first_name || 'N/A'}\n` +
    `Role:       ${u.role}\n` +
    `Premium:    ${prem ? (u.premium_until ? `Yes (until ${u.premium_until})` : 'Yes (Lifetime)') : 'No'}\n` +
    `Blocked:    ${u.is_blocked ? 'Yes' : 'No'}\n\n` +
    `Total checks:  ${u.numbers_checked || 0}\n` +
    `Bonus checks:  ${u.bonus_checks || 0}\n` +
    `Refer code:    ${u.refer_code || 'N/A'}\n` +
    `Referrals:     ${u.refer_count || 0}\n` +
    `Joined:        ${u.joined_at}\n` +
    `Last active:   ${u.last_active}\n`;
  await bot.sendDocument(chatId, Buffer.from(txt, 'utf-8'),
    { caption: '📄 Your profile data' },
    { filename: `profile_${userId}.txt`, contentType: 'text/plain' });
}

// ════════════════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ════════════════════════════════════════════════════════════════════════════

bot.on('message', async msg => {
  // If this message was already handled by an onText handler — skip it entirely
  if (alreadyHandled(msg.message_id)) return;

  const chatId    = msg.chat.id;
  const userId    = msg.from.id;
  const username  = msg.from.username || '';
  const firstName = msg.from.first_name || '';
  const text      = msg.text;

  // Ignore all slash commands — handled by onText listeners
  if (!text || text.startsWith('/')) return;

  // ✅ FIX: Ignore forwarded messages and channel posts
  if (msg.forward_date || msg.chat.type === 'channel') return;

  if (isMaintenanceMode() && !isAdmin(userId)) {
    return bot.sendMessage(chatId, `🔧 <b>Maintenance Mode</b>\n\nBot is under maintenance. Please check back soon.`, { parse_mode: 'HTML' });
  }

  db.createUser(userId, username, firstName);

  const isMember = await checkForceSub(userId);
  if (!isMember) {
    const info = await getFsubChannelInfo();
    const linkText = info?.link || info?.id || '';
    const title = info?.title || 'our channel';
    return bot.sendMessage(chatId,
      `🔒 <b>Access Required</b>\n\nPlease join <b>${esc(title)}</b> first:\n👉 ${esc(linkText)}\n\nAfter joining, click /start.`,
      { parse_mode: 'HTML', disable_web_page_preview: false });
  }

  if (!isAuthorized(userId)) {
    if (config.OWNER_ID) {
      broadcastAdmins(`⚠️ <b>Unauthorized Access Attempt</b>\n\n👤 @${esc(username)} (<code>${userId}</code>)\n\nThey tried to use the bot without access.`);
    }
    return bot.sendMessage(chatId, `🔒 <b>Access Denied</b>\n\nYou don't have permission to use this bot.\n\nContact <a href="https://t.me/bhardwa_j">@Bhardwa_j</a> for access.`, { parse_mode: 'HTML', disable_web_page_preview: true });
  }

  const state = userStates.get(userId);

  // ── Admin states ──────────────────────────────────────────────────────

  if (state?.mode === 'broadcast') {
    userStates.delete(userId);
    const users  = db.getAllUsers();
    let sent = 0, failed = 0;
    const statusMsg = await bot.sendMessage(chatId, `📢 Broadcasting to ${users.length} users...`);
    for (const u of users) {
      try {
        await bot.sendMessage(u.telegram_id, text, { parse_mode: 'HTML' });
        sent++;
      } catch (_) { failed++; }
      await sleep(50);
    }
    logEvent(userId, username, 'Broadcast', `Sent: ${sent}, Failed: ${failed}`);
    return bot.editMessageText(`📢 <b>Broadcast Complete</b>\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });
  }

  if (state?.mode === 'add_account') {
    userStates.delete(userId);
    const id = text.trim().replace(/\s+/g,'_').toLowerCase();
    if (!/^[a-z0-9_]+$/.test(id)) return bot.sendMessage(chatId, '❌ Invalid name. Use only lowercase letters, numbers, underscores.');
    if (db.getAccount(id)) return bot.sendMessage(chatId, `❌ Account <code>${esc(id)}</code> already exists.`, { parse_mode: 'HTML' });
    db.addAccount(id, id, 'checker');
    accounts.set(id, { status: 'disconnected', sock: null, qrCode: null, retryCount: 0, retryTimer: null, phoneNumber: null, accountType: 'checker' });
    logEvent(userId, username, 'WA Account Added', id);
    const msg = `➕ <b>Account Added</b>\n\nID: <code>${esc(id)}</code>\nType: <code>checker</code>`;
    sendLog(msg);
    broadcastOwner(msg);
    return bot.sendMessage(chatId,
      `✅ Account <b>${esc(id)}</b> created!\n\nHow would you like to connect?`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: '📷 QR Code', callback_data: `wa_qr_${id}` }],
        [{ text: '🔗 Pairing Code', callback_data: `wa_pair_${id}` }],
        [{ text: '‹ Back', callback_data: 'op_accounts' }],
      ]}});
  }

  if (state?.mode === 'pair_wa') {
    const { accountId, accountType } = state;
    userStates.delete(userId);
    const statusMsg = await bot.sendMessage(chatId, `⏳ Generating pairing code for <b>${esc(accountId)}</b>...`, { parse_mode: 'HTML' });
    try {
      const code = await getPairingCode(accountId, text.trim(), accountType);
      return bot.editMessageText(
        `🔗 <b>Pairing Code — ${esc(accountId)}</b>\n\n` +
        `Code: <code>${code}</code>\n\n` +
        `<b>Steps:</b>\n1. Open WhatsApp\n2. Settings → Linked Devices\n3. Link a Device\n4. Link with phone number\n5. Enter the code above\n\n` +
        `✅ Bot will notify you when connected.`,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '‹ Back', callback_data: 'op_accounts' }]] } });
    } catch (err) {
      return bot.editMessageText(`❌ <b>Pairing Failed</b>\n\n${esc(err.message)}`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML', reply_markup: backBtn });
    }
  }

  if (state?.mode === 'add_premium_uid') {
    userStates.set(userId, { mode: 'add_premium_days', targetId: parseInt(text.trim()) });
    const tid = parseInt(text.trim());
    if (isNaN(tid)) {
      userStates.delete(userId);
      return bot.sendMessage(chatId, '❌ Invalid Telegram ID. Must be a number.');
    }
    return bot.sendMessage(chatId,
      `💎 Adding premium to <code>${tid}</code>\n\nSend duration:\n• Number of days: <code>30</code>\n• Or lifetime: <code>lifetime</code>`,
      { parse_mode: 'HTML' });
  }

  if (state?.mode === 'add_premium_days') {
    const { targetId } = state;
    userStates.delete(userId);
    let until = null;
    if (text.trim().toLowerCase() !== 'lifetime') {
      const days = parseInt(text.trim());
      if (isNaN(days) || days < 1) return bot.sendMessage(chatId, '❌ Invalid. Send a number of days or "lifetime".');
      until = new Date();
      until.setDate(until.getDate() + days);
    }
    db.createUser(targetId, '', '', 'user');
    db.setPremium(targetId, until);
    const expTxt = until ? `until ${until.toLocaleDateString()}` : 'Lifetime';
    logEvent(userId, username, 'Premium Added', `User ${targetId} — ${expTxt}`);
    bot.sendMessage(targetId,
      `💎 <b>Premium Activated!</b>\n\n${until ? `Your premium is active until <b>${until.toLocaleDateString()}</b>.` : '✨ You have <b>Lifetime Premium</b>!'}\n\nEnjoy your benefits!`,
      { parse_mode: 'HTML' }).catch(() => {});
    return bot.sendMessage(chatId, `✅ Premium granted to <code>${targetId}</code> — ${expTxt}`, { parse_mode: 'HTML' });
  }

  if (state?.mode === 'set_fsub_image') {
    userStates.delete(userId);
    db.setSetting('fsub_image', text.trim());
    return bot.sendMessage(chatId,
      `✅ <b>FSub image URL saved!</b>\nIt will now appear with the join prompt.`,
      { parse_mode: 'HTML' });
  }

  if (state?.mode === 'set_menu_image') {
    userStates.delete(userId);
    db.setSetting('menu_image', text.trim());
    return bot.sendMessage(chatId,
      `✅ <b>Menu image URL saved!</b>\nIt will now appear with the main menu.`,
      { parse_mode: 'HTML' });
  }

  if (state?.mode === 'set_fsub') {
    userStates.delete(userId);
    const ch = text.trim();
    db.setSetting('fsub_channel', ch);
    // ✅ FIX: Auto-fetch channel info after setting
    const info = await getFsubChannelInfo();
    let reply = `✅ Force subscribe channel set!\n\n`;
    if (info && info.title !== ch) {
      reply += `📢 Channel: <b>${esc(info.title)}</b>\n`;
      if (info.username) reply += `🔗 ${esc(info.username)}\n`;
      if (info.link) reply += `📎 ${esc(info.link)}\n`;
    } else {
      reply += `ID: <code>${esc(ch)}</code>`;
    }
    reply += `\n\n⚠️ Make sure the bot is an <b>admin</b> in that channel/group!`;
    return bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });
  }

  if (state?.mode === 'set_free_limit') {
    userStates.delete(userId);
    const v = parseInt(text);
    if (isNaN(v) || v < 1) return bot.sendMessage(chatId, '❌ Invalid number.');
    db.setSetting('free_limit', String(v));
    return bot.sendMessage(chatId, `✅ Free daily limit set to <b>${v}</b>`, { parse_mode: 'HTML' });
  }

  if (state?.mode === 'set_prem_limit') {
    userStates.delete(userId);
    const v = parseInt(text);
    if (isNaN(v) || v < 1) return bot.sendMessage(chatId, '❌ Invalid number.');
    db.setSetting('prem_limit', String(v));
    return bot.sendMessage(chatId, `✅ Premium daily limit set to <b>${v}</b>`, { parse_mode: 'HTML' });
  }

  if (state?.mode === 'set_bulk_limit') {
    userStates.delete(userId);
    const v = parseInt(text);
    if (isNaN(v) || v < 1) return bot.sendMessage(chatId, '❌ Invalid number.');
    db.setSetting('bulk_limit', String(v));
    return bot.sendMessage(chatId, `✅ Bulk check limit set to <b>${v}</b>`, { parse_mode: 'HTML' });
  }

  if (state?.mode === 'set_refer_bonus') {
    userStates.delete(userId);
    const v = parseInt(text);
    if (isNaN(v) || v < 0) return bot.sendMessage(chatId, '❌ Invalid number.');
    db.setSetting('refer_bonus', String(v));
    return bot.sendMessage(chatId, `✅ Referral bonus set to <b>${v} checks</b>`, { parse_mode: 'HTML' });
  }

  if (state?.mode === 'set_log_group') {
    userStates.delete(userId);
    db.setSetting('log_group_id', text.trim());
    return bot.sendMessage(chatId, `✅ Log group set to: <code>${esc(text.trim())}</code>`, { parse_mode: 'HTML' });
  }

  if (state?.mode === 'upload') {
    const nums = text.split(/[\n,\s]+/).filter(n => /^\d{7,15}$/.test(n.replace(/\D/g,'')));
    if (!nums.length) return bot.sendMessage(chatId, '❌ No valid numbers found.');
    for (const n of nums) db.addNumber(userId, n.replace(/\D/g,''));
    return bot.sendMessage(chatId, `✅ <b>${nums.length} numbers</b> added to your pool!`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '‹ Back to Tools', callback_data: 'tools' }]] }});
  }

  // ✅ FIX: Only check numbers when user is in check_single or bulk_check mode
  // If no state set, show menu — don't process random messages as numbers
  if (!state || (state.mode !== 'check_single' && state.mode !== 'bulk_check')) {
    return sendWelcome(chatId, userId);
  }

  // ── Number checking ────────────────────────────────────────────────────
  if (!hasAnyChecker()) {
    return bot.sendMessage(chatId,
      `❌ <b>No WhatsApp accounts connected.</b>\n\nPlease contact the admin.`,
      { parse_mode: 'HTML' });
  }

  const paidMode = db.getSetting('paid_mode') === 'true';
  if (paidMode && !isPremium(userId) && !isAdmin(userId)) {
    return bot.sendMessage(chatId,
      `🔒 <b>Premium Required</b>\n\nNumber checking requires a premium subscription.\n\nUpgrade to continue:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '💎 View Premium Plans', callback_data: 'premium_info' }]] }});
  }

  const nums = text.split(/[\n,\s]+/).filter(n => /^\d{7,15}$/.test(n.replace(/\D/g,'')));
  if (!nums.length) {
    return bot.sendMessage(chatId, `❌ No valid phone numbers found.\n\nSend numbers with country code, e.g. <code>919876543210</code>`, { parse_mode: 'HTML' });
  }

  const freeLimit = parseInt(db.getSetting('free_limit') || '20');
  const premLimit = parseInt(db.getSetting('prem_limit') || '500');
  const bulk      = parseInt(db.getSetting('bulk_limit') || '100');
  const limits    = db.getRemainingChecks(userId, freeLimit, premLimit);

  if (limits.remaining <= 0) {
    return bot.sendMessage(chatId,
      `⏳ <b>Daily Limit Reached</b>\n\nYou've used all <b>${limits.limit}</b> daily checks.\n\n${limits.isPremium ? 'Resets at midnight.' : 'Upgrade to Premium for more checks:'}`,
      { parse_mode: 'HTML', reply_markup: limits.isPremium ? undefined : { inline_keyboard: [[{ text: '💎 Upgrade to Premium', callback_data: 'premium_info' }]] }});
  }

  if (nums.length > bulk) {
    return bot.sendMessage(chatId, `❌ Maximum <b>${bulk}</b> numbers per request.`, { parse_mode: 'HTML' });
  }

  const allowed = Math.min(nums.length, limits.remaining);
  const toCheck = nums.slice(0, allowed);

  // ✅ FIX: Clear state after receiving numbers, so next message doesn't auto-check
  userStates.delete(userId);

  logEvent(userId, username, 'Number Check', `${toCheck.length} numbers`);
  await processNumbers(chatId, userId, toCheck);
});

// ─── DOCUMENT HANDLER ─────────────────────────────────────────────────────
// ─── PHOTO HANDLER (for fsub image upload) ───────────────────────────────
bot.on('photo', async msg => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!userId || !isAdmin(userId)) return;
  const state = userStates.get(userId);
  if (!state || !['set_fsub_image', 'set_menu_image'].includes(state.mode)) return;
  userStates.delete(userId);
  const photo  = msg.photo[msg.photo.length - 1];
  const fileId = photo.file_id;
  if (state.mode === 'set_fsub_image') {
    db.setSetting('fsub_image', fileId);
    return bot.sendMessage(chatId,
      `✅ <b>FSub image saved!</b>\nThis photo will appear with the join prompt.`,
      { parse_mode: 'HTML' });
  } else {
    db.setSetting('menu_image', fileId);
    return bot.sendMessage(chatId,
      `✅ <b>Menu image saved!</b>\nThis photo will appear with the main menu.`,
      { parse_mode: 'HTML' });
  }
});

bot.on('document', async msg => {
  const chatId   = msg.chat.id;
  const userId   = msg.from.id;
  const username = msg.from.username || '';

  if (isMaintenanceMode() && !isAdmin(userId)) return;

  db.createUser(userId, username, msg.from.first_name || '');
  if (!isAuthorized(userId)) return bot.sendMessage(chatId, '🔒 Access denied.');
  if (!msg.document.file_name.endsWith('.txt')) return bot.sendMessage(chatId, '❌ Please send a <code>.txt</code> file.', { parse_mode: 'HTML' });

  const state = userStates.get(userId);

  try {
    const file    = await bot.getFile(msg.document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const resp    = await fetch(fileUrl);
    const txt     = await resp.text();
    const nums    = txt.split(/[\n,\s]+/).filter(n => /^\d{7,15}$/.test(n.replace(/\D/g,'')));

    if (!nums.length) return bot.sendMessage(chatId, '❌ No valid numbers found in file.');

    if (state?.mode === 'upload') {
      userStates.delete(userId);
      for (const n of nums) db.addNumber(userId, n.replace(/\D/g,''));
      return bot.sendMessage(chatId, `✅ <b>${nums.length} numbers</b> added to your pool!`, { parse_mode: 'HTML' });
    }

    // ✅ FIX: Only allow file checking if user is in bulk_check mode
    if (state?.mode !== 'bulk_check') {
      return bot.sendMessage(chatId,
        `📁 To check numbers from a file, first tap <b>Bulk Check</b> then send the file.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📁 Bulk Check', callback_data: 'bulk_check' }]] }});
    }

    if (!hasAnyChecker()) return bot.sendMessage(chatId, '❌ No WhatsApp accounts connected.');

    const paidMode = db.getSetting('paid_mode') === 'true';
    if (paidMode && !isPremium(userId) && !isAdmin(userId)) {
      return bot.sendMessage(chatId, `🔒 <b>Premium Required</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '💎 View Plans', callback_data: 'premium_info' }]] }});
    }

    const freeLimit = parseInt(db.getSetting('free_limit') || '20');
    const premLimit = parseInt(db.getSetting('prem_limit') || '500');
    const bulk      = parseInt(db.getSetting('bulk_limit') || '100');
    const limits    = db.getRemainingChecks(userId, freeLimit, premLimit);

    if (limits.remaining <= 0) return bot.sendMessage(chatId, `⏳ Daily limit reached.`);
    if (nums.length > bulk)    return bot.sendMessage(chatId, `❌ File has ${nums.length} numbers. Max ${bulk} allowed.`);

    const toCheck = nums.slice(0, limits.remaining);
    // ✅ FIX: Clear state after receiving file
    userStates.delete(userId);
    logEvent(userId, username, 'Bulk File Check', `${toCheck.length} numbers`);
    await processNumbers(chatId, userId, toCheck, { alwaysTxt: true });
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${esc(err.message)}`);
  }
});

// ─── PROCESS NUMBERS ──────────────────────────────────────────────────────
async function processNumbers(chatId, userId, numbers, opts = {}) {
  const { alwaysTxt = false } = opts;
  const startedAt    = Date.now();
  const checkerCount = getConnectedCheckers().length;

  const statusMsg = await bot.sendMessage(chatId,
    buildProgressText(0, numbers.length, startedAt, checkerCount),
    { parse_mode: 'HTML' });

  let done    = 0;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    bot.editMessageText(buildProgressText(done, numbers.length, startedAt, getConnectedCheckers().length), {
      chat_id:    chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'HTML',
    }).catch(() => {});
  }, 3000);

  const results = await bulkCheck(numbers, d => { done = d; });

  stopped = true;
  clearInterval(timer);

  const reg   = results.filter(r => r?.is_registered === true);
  const noReg = results.filter(r => r?.is_registered === false);
  const unk   = results.filter(r => r?.is_registered === null);

  db.incrementStats(reg.length, noReg.length);
  db.incrementDailyChecks(userId, numbers.length);

  const lines = [
    `✅ <b>Results</b>`,
    ``,
    `📊 Total:          <code>${numbers.length}</code>`,
    `✅ Registered:     <code>${reg.length}</code>`,
    `❌ Not Registered: <code>${noReg.length}</code>`,
    `❓ Unknown:        <code>${unk.length}</code>`,
  ];
  if (checkerCount > 1) lines.push(`\n🔀 Processed via <b>${checkerCount}</b> accounts in parallel`);

  const sendTxt = alwaysTxt || numbers.length > 50;
  if (sendTxt) {
    const sendFile = async (arr, name, cap) => {
      if (!arr.length) return;
      await bot.sendDocument(chatId, Buffer.from(arr.map(r=>r.phone_number).join('\n'), 'utf-8'),
        { caption: cap }, { filename: name, contentType: 'text/plain; charset=utf-8' }).catch(() => {});
    };
    await sendFile(reg,   'registered.txt',     `✅ ${reg.length} registered numbers`);
    await sendFile(noReg, 'not_registered.txt',  `❌ ${noReg.length} not registered`);
    await sendFile(unk,   'unknown.txt',          `❓ ${unk.length} unknown`);
    lines.push('', '📎 Results sent as files.');
  } else {
    const preview = (label, arr, ic) => {
      if (!arr.length) return;
      lines.push('', `<b>${label}:</b>`);
      arr.slice(0,30).forEach(r => lines.push(`${ic} <code>${esc(r.phone_number)}</code>`));
      if (arr.length > 30) lines.push(`  … +${arr.length-30} more`);
    };
    preview('Registered', reg, '✅');
    preview('Not Registered', noReg, '❌');
    preview('Unknown', unk, '❓');
  }

  await bot.editMessageText(lines.join('\n'), {
    chat_id:    chatId,
    message_id: statusMsg.message_id,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '‹ Back to Menu', callback_data: 'main_menu' }]] },
  }).catch(async () => {
    await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '‹ Back to Menu', callback_data: 'main_menu' }]] }}).catch(() => {});
  });
}

function buildProgressText(done, total, startedAt, accts) {
  const pct     = total === 0 ? 0 : Math.floor((done/total)*100);
  const bar     = progressBar(done, total);
  const elapsed = Date.now() - startedAt;
  const rate    = done > 0 ? elapsed / done : null;
  const eta     = rate ? Math.max(0, Math.round(rate * (total - done) / 1000)) : null;
  const acctL   = accts > 1 ? `\n🔀 <b>${accts}</b> accounts in parallel` : '';
  return `⏳ <b>Checking numbers...</b> ${done}/${total}\n<code>${bar}</code> ${pct}%${eta !== null ? `\n⏱ ETA: ~${eta}s` : ''}${acctL}`;
}

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN TEXT COMMANDS
// ════════════════════════════════════════════════════════════════════════════

bot.onText(/\/ban (\d+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  db.blockUser(parseInt(match[1]), true);
  bot.sendMessage(msg.chat.id, `✅ User <code>${match[1]}</code> banned.`, { parse_mode: 'HTML' });
});
bot.onText(/\/unban (\d+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  db.blockUser(parseInt(match[1]), false);
  bot.sendMessage(msg.chat.id, `✅ User <code>${match[1]}</code> unbanned.`, { parse_mode: 'HTML' });
});
bot.onText(/\/promote (\d+)/, (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  db.updateRole(parseInt(match[1]), 'admin');
  bot.sendMessage(msg.chat.id, `✅ User <code>${match[1]}</code> promoted to admin.`, { parse_mode: 'HTML' });
});
bot.onText(/\/demote (\d+)/, (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  db.updateRole(parseInt(match[1]), 'user');
  bot.sendMessage(msg.chat.id, `✅ User <code>${match[1]}</code> demoted.`, { parse_mode: 'HTML' });
});
bot.onText(/\/addprem (\d+) (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const targetId = parseInt(match[1]);
  const dur      = match[2].trim();
  let until      = null;
  if (dur !== 'lifetime') {
    const days = parseInt(dur);
    if (isNaN(days)) return bot.sendMessage(msg.chat.id, '❌ Use: /addprem <id> <days> or /addprem <id> lifetime');
    until = new Date();
    until.setDate(until.getDate() + days);
  }
  db.createUser(targetId, '', '', 'user');
  db.setPremium(targetId, until);
  bot.sendMessage(msg.chat.id, `✅ Premium granted to <code>${targetId}</code> — ${until ? until.toLocaleDateString() : 'Lifetime'}`, { parse_mode: 'HTML' });
  bot.sendMessage(targetId, `💎 <b>Premium Activated!</b>\n\n${until ? `Active until ${until.toLocaleDateString()}` : '✨ Lifetime Premium'}\n\nUse /start to continue.`, { parse_mode: 'HTML' }).catch(() => {});
});
bot.onText(/\/remprem (\d+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  db.removePremium(parseInt(match[1]));
  bot.sendMessage(msg.chat.id, `✅ Premium removed from <code>${match[1]}</code>`, { parse_mode: 'HTML' });
});
bot.onText(/\/user (\d+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const u = db.getUser(parseInt(match[1]));
  if (!u) return bot.sendMessage(msg.chat.id, '❌ User not found.');
  const prem = db.isPremiumActive(u.telegram_id);
  bot.sendMessage(msg.chat.id,
    `👤 <b>User Info</b>\n\n🆔 <code>${u.telegram_id}</code>\n@${esc(u.username)||'N/A'}\nRole: ${u.role}\nPremium: ${prem ? 'Yes' : 'No'}\nBlocked: ${u.is_blocked ? 'Yes' : 'No'}\nChecks: ${u.numbers_checked}`,
    { parse_mode: 'HTML' });
});

// ════════════════════════════════════════════════════════════════════════════
//  EXPRESS SERVER
// ════════════════════════════════════════════════════════════════════════════

app.get('/',       (_, res) => res.json({ status: 'running', name: 'WA Number Checker Bot' }));
app.get('/health', (_, res) => {
  res.json({
    status:   'ok',
    checkers: getConnectedCheckers().length,
    accounts: db.getAllAccounts().map(a => ({ id: a.account_id, connected: !!a.is_connected, type: a.account_type })),
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════════════════════════════

const PORT = config.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  await connectAllSaved();
  console.log('✅ WhatsApp Number Checker Bot started!');
});