const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : (fs.existsSync('/var/data') ? '/var/data' : path.join(__dirname, 'data'));

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'bot.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id   INTEGER PRIMARY KEY,
    username      TEXT,
    first_name    TEXT,
    role          TEXT    DEFAULT 'user',
    is_blocked    INTEGER DEFAULT 0,
    is_allowed    INTEGER DEFAULT 0,
    is_premium    INTEGER DEFAULT 0,
    premium_until TEXT,
    numbers_checked INTEGER DEFAULT 0,
    daily_checks  INTEGER DEFAULT 0,
    daily_reset   TEXT    DEFAULT CURRENT_DATE,
    refer_code    TEXT    UNIQUE,
    referred_by   INTEGER,
    refer_count   INTEGER DEFAULT 0,
    bonus_checks  INTEGER DEFAULT 0,
    joined_at     TEXT    DEFAULT CURRENT_TIMESTAMP,
    last_active   TEXT    DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS stats (
    date                 TEXT PRIMARY KEY,
    total_checks         INTEGER DEFAULT 0,
    registered_count     INTEGER DEFAULT 0,
    not_registered_count INTEGER DEFAULT 0,
    unique_users         INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS number_pool (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    phone_number TEXT    NOT NULL,
    is_used      INTEGER DEFAULT 0,
    created_at   TEXT    DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS wa_accounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   TEXT    NOT NULL UNIQUE,
    label        TEXT,
    phone_number TEXT,
    account_type TEXT    DEFAULT 'checker',
    is_enabled   INTEGER DEFAULT 1,
    is_connected INTEGER DEFAULT 0,
    added_at     TEXT    DEFAULT CURRENT_TIMESTAMP,
    last_connected TEXT,
    total_checks INTEGER DEFAULT 0,
    ban_count    INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS refer_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL,
    referred_id INTEGER NOT NULL,
    bonus_given INTEGER DEFAULT 0,
    created_at  TEXT    DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrations
const migrations = [
  `ALTER TABLE users ADD COLUMN is_allowed INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN is_premium INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN premium_until TEXT`,
  `ALTER TABLE users ADD COLUMN daily_checks INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN daily_reset TEXT DEFAULT CURRENT_DATE`,
  `ALTER TABLE users ADD COLUMN refer_code TEXT`,
  `ALTER TABLE users ADD COLUMN referred_by INTEGER`,
  `ALTER TABLE users ADD COLUMN refer_count INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN bonus_checks INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN first_name TEXT`,
  `ALTER TABLE wa_accounts ADD COLUMN account_type TEXT DEFAULT 'checker'`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) {}
}

// ─── HELPERS ────────────────────────────────────────────────────────────────
function generateReferCode(telegramId) {
  return 'REF' + telegramId.toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

module.exports = {

  // ─── USERS ────────────────────────────────────────────────────────────────

  getUser(telegramId) {
    return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  },

  createUser(telegramId, username, firstName, role = 'user') {
    const existing = db.prepare('SELECT telegram_id, refer_code FROM users WHERE telegram_id = ?').get(telegramId);
    if (existing) {
      db.prepare(`UPDATE users SET username=?, first_name=?, last_active=CURRENT_TIMESTAMP WHERE telegram_id=?`)
        .run(username, firstName, telegramId);
      return false; // not new
    }
    const referCode = generateReferCode(telegramId);
    db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, role, refer_code)
      VALUES (?, ?, ?, ?, ?)
    `).run(telegramId, username, firstName, role, referCode);
    return true; // new user
  },

  getAllUsers() {
    return db.prepare('SELECT * FROM users ORDER BY joined_at DESC').all();
  },

  getAdmins() {
    return db.prepare("SELECT * FROM users WHERE role IN ('admin','owner')").all();
  },

  updateRole(telegramId, role) {
    return db.prepare('UPDATE users SET role=? WHERE telegram_id=?').run(role, telegramId);
  },

  blockUser(telegramId, blocked) {
    return db.prepare('UPDATE users SET is_blocked=? WHERE telegram_id=?').run(blocked ? 1 : 0, telegramId);
  },

  setPremium(telegramId, until) {
    // until = Date object or null (lifetime)
    return db.prepare('UPDATE users SET is_premium=1, is_allowed=1, premium_until=? WHERE telegram_id=?')
      .run(until ? until.toISOString() : null, telegramId);
  },

  removePremium(telegramId) {
    return db.prepare('UPDATE users SET is_premium=0, premium_until=NULL WHERE telegram_id=?').run(telegramId);
  },

  isPremiumActive(telegramId) {
    const u = db.prepare('SELECT is_premium, premium_until FROM users WHERE telegram_id=?').get(telegramId);
    if (!u || !u.is_premium) return false;
    if (!u.premium_until) return true; // lifetime
    return new Date(u.premium_until) > new Date();
  },

  // Daily checks — auto reset if new day
  getDailyChecks(telegramId) {
    const u = db.prepare('SELECT daily_checks, daily_reset FROM users WHERE telegram_id=?').get(telegramId);
    if (!u) return 0;
    const today = new Date().toISOString().split('T')[0];
    if (u.daily_reset !== today) {
      db.prepare('UPDATE users SET daily_checks=0, daily_reset=? WHERE telegram_id=?').run(today, telegramId);
      return 0;
    }
    return u.daily_checks || 0;
  },

  incrementDailyChecks(telegramId, count) {
    const today = new Date().toISOString().split('T')[0];
    db.prepare(`
      UPDATE users SET
        daily_checks = CASE WHEN daily_reset=? THEN daily_checks+? ELSE ? END,
        daily_reset  = ?,
        numbers_checked = numbers_checked + ?,
        last_active = CURRENT_TIMESTAMP
      WHERE telegram_id=?
    `).run(today, count, count, today, count, telegramId);
  },

  getRemainingChecks(telegramId, freeLimit, premiumLimit) {
    const u = db.prepare('SELECT is_premium, premium_until, daily_checks, daily_reset, bonus_checks FROM users WHERE telegram_id=?').get(telegramId);
    if (!u) return { limit: freeLimit, used: 0, remaining: freeLimit, isPremium: false };
    const today = new Date().toISOString().split('T')[0];
    const used = u.daily_reset === today ? (u.daily_checks || 0) : 0;
    const isPrem = u.is_premium && (!u.premium_until || new Date(u.premium_until) > new Date());
    const limit = isPrem ? premiumLimit : freeLimit;
    const bonus = u.bonus_checks || 0;
    const remaining = Math.max(0, limit + bonus - used);
    return { limit, used, remaining, isPremium: isPrem, bonus };
  },

  // ─── REFER ────────────────────────────────────────────────────────────────

  getUserByReferCode(code) {
    return db.prepare('SELECT * FROM users WHERE refer_code=?').get(code);
  },

  applyReferral(referrerId, referredId, bonusChecks = 10) {
    const already = db.prepare('SELECT id FROM refer_log WHERE referred_id=?').get(referredId);
    if (already) return false;
    db.prepare('INSERT INTO refer_log (referrer_id, referred_id, bonus_given) VALUES (?,?,?)').run(referrerId, referredId, bonusChecks);
    db.prepare('UPDATE users SET refer_count=refer_count+1, bonus_checks=bonus_checks+? WHERE telegram_id=?').run(bonusChecks, referrerId);
    db.prepare('UPDATE users SET referred_by=? WHERE telegram_id=?').run(referrerId, referredId);
    return true;
  },

  // ─── SETTINGS ─────────────────────────────────────────────────────────────

  getSetting(key) {
    return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  },

  setSetting(key, value) {
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  },

  // ─── STATS ────────────────────────────────────────────────────────────────

  incrementStats(registered, notRegistered) {
    const today = new Date().toISOString().split('T')[0];
    db.prepare(`
      INSERT INTO stats (date, total_checks, registered_count, not_registered_count, unique_users)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(date) DO UPDATE SET
        total_checks         = total_checks + ?,
        registered_count     = registered_count + ?,
        not_registered_count = not_registered_count + ?
    `).run(today, registered + notRegistered, registered, notRegistered,
           registered + notRegistered, registered, notRegistered);
  },

  getTotalStats() {
    return db.prepare(`
      SELECT SUM(total_checks) as total_checks,
             SUM(registered_count) as registered_count,
             SUM(not_registered_count) as not_registered_count
      FROM stats
    `).get();
  },

  getStatsHistory(days = 7) {
    return db.prepare('SELECT * FROM stats ORDER BY date DESC LIMIT ?').all(days);
  },

  // ─── NUMBER POOL ──────────────────────────────────────────────────────────

  addNumber(userId, phoneNumber) {
    return db.prepare('INSERT INTO number_pool (user_id, phone_number) VALUES (?,?)').run(userId, phoneNumber);
  },

  getNextNumber(userId) {
    const n = db.prepare('SELECT * FROM number_pool WHERE user_id=? AND is_used=0 ORDER BY id ASC LIMIT 1').get(userId);
    if (n) db.prepare('UPDATE number_pool SET is_used=1 WHERE id=?').run(n.id);
    return n;
  },

  getNumberCount(userId) {
    return db.prepare('SELECT COUNT(*) as c FROM number_pool WHERE user_id=? AND is_used=0').get(userId)?.c || 0;
  },

  // ─── WA ACCOUNTS ──────────────────────────────────────────────────────────

  getAllAccounts() {
    return db.prepare('SELECT * FROM wa_accounts ORDER BY account_type ASC, id ASC').all();
  },

  getAccount(accountId) {
    return db.prepare('SELECT * FROM wa_accounts WHERE account_id=?').get(accountId);
  },

  addAccount(accountId, label, type = 'checker') {
    return db.prepare('INSERT OR IGNORE INTO wa_accounts (account_id, label, account_type) VALUES (?,?,?)').run(accountId, label || accountId, type);
  },

  removeAccount(accountId) {
    return db.prepare('DELETE FROM wa_accounts WHERE account_id=?').run(accountId);
  },

  setAccountConnected(accountId, isConnected, phoneNumber = null) {
    const now = new Date().toISOString();
    return db.prepare(`
      UPDATE wa_accounts SET
        is_connected   = ?,
        phone_number   = COALESCE(?, phone_number),
        last_connected = CASE WHEN ?=1 THEN ? ELSE last_connected END
      WHERE account_id=?
    `).run(isConnected ? 1 : 0, phoneNumber, isConnected ? 1 : 0, now, accountId);
  },

  setAccountEnabled(accountId, enabled) {
    return db.prepare('UPDATE wa_accounts SET is_enabled=? WHERE account_id=?').run(enabled ? 1 : 0, accountId);
  },

  setAccountType(accountId, type) {
    return db.prepare("UPDATE wa_accounts SET account_type=? WHERE account_id=?").run(type, accountId);
  },

  incrementBanCount(accountId) {
    return db.prepare('UPDATE wa_accounts SET ban_count=ban_count+1, is_enabled=0, is_connected=0 WHERE account_id=?').run(accountId);
  },

  incrementAccountChecks(accountId, count = 1) {
    return db.prepare('UPDATE wa_accounts SET total_checks=total_checks+? WHERE account_id=?').run(count, accountId);
  },

  getActiveCheckerAccounts() {
    return db.prepare(`
      SELECT * FROM wa_accounts
      WHERE is_connected=1 AND is_enabled=1 AND account_type='checker'
      ORDER BY total_checks ASC
    `).all();
  },

  getEnabledBackupAccounts() {
    return db.prepare(`
      SELECT * FROM wa_accounts
      WHERE is_enabled=1 AND account_type='backup'
      ORDER BY id ASC
    `).all();
  },
};