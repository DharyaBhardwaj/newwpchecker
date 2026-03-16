const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Prefer Render persistent disk when available
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : (fs.existsSync('/var/data') ? '/var/data' : path.join(__dirname, 'data'));

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'bot.db'));

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    role TEXT DEFAULT 'user',
    is_blocked INTEGER DEFAULT 0,
    is_allowed INTEGER DEFAULT 0,
    expires_at TEXT,
    numbers_checked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_active TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS whatsapp_session (
    id INTEGER PRIMARY KEY DEFAULT 1,
    session_data TEXT,
    is_connected INTEGER DEFAULT 0,
    phone_number TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS stats (
    date TEXT PRIMARY KEY,
    total_checks INTEGER DEFAULT 0,
    registered_count INTEGER DEFAULT 0,
    not_registered_count INTEGER DEFAULT 0,
    unique_users INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS number_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    phone_number TEXT NOT NULL,
    is_used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS wa_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL UNIQUE,
    label TEXT,
    phone_number TEXT,
    is_enabled INTEGER DEFAULT 1,
    is_connected INTEGER DEFAULT 0,
    added_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_connected TEXT,
    total_checks INTEGER DEFAULT 0,
    ban_count INTEGER DEFAULT 0
  );
`);

// Initialize default session row (legacy)
db.prepare(`INSERT OR IGNORE INTO whatsapp_session (id) VALUES (1)`).run();

// Migrations for older installs
const migrations = [
  `ALTER TABLE users ADD COLUMN is_allowed INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN expires_at TEXT`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) {}
}

module.exports = {

  // ========== USER MANAGEMENT ==========

  getUser: (telegramId) => {
    return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  },

  createUser: (telegramId, username, role = 'user') => {
    return db.prepare(`
      INSERT INTO users (telegram_id, username, role)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        last_active = CURRENT_TIMESTAMP
    `).run(telegramId, username, role);
  },

  updateUserRole: (telegramId, role) => {
    return db.prepare('UPDATE users SET role = ? WHERE telegram_id = ?').run(role, telegramId);
  },

  blockUser: (telegramId, blocked = true) => {
    return db.prepare('UPDATE users SET is_blocked = ? WHERE telegram_id = ?').run(blocked ? 1 : 0, telegramId);
  },

  getAllUsers: () => {
    return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  },

  getAdmins: () => {
    return db.prepare("SELECT * FROM users WHERE role IN ('admin', 'owner')").all();
  },

  incrementChecks: (telegramId, count = 1) => {
    return db.prepare(`
      UPDATE users SET
        numbers_checked = numbers_checked + ?,
        last_active = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
    `).run(count, telegramId);
  },

  getUserStats: (telegramId) => {
    return db.prepare('SELECT numbers_checked as total_checks FROM users WHERE telegram_id = ?').get(telegramId);
  },

  grantAccess: (telegramId, expiresAt) => {
    const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
    if (!existing) {
      db.prepare('INSERT INTO users (telegram_id, is_allowed, expires_at) VALUES (?, 1, ?)').run(
        telegramId,
        expiresAt ? expiresAt.toISOString() : null
      );
    } else {
      db.prepare('UPDATE users SET is_allowed = 1, expires_at = ? WHERE telegram_id = ?').run(
        expiresAt ? expiresAt.toISOString() : null,
        telegramId
      );
    }
  },

  // ========== SESSION (legacy single-account) ==========

  getSession: () => {
    return db.prepare('SELECT * FROM whatsapp_session WHERE id = 1').get();
  },

  saveSession: (sessionData, isConnected = false, phoneNumber = null) => {
    return db.prepare(`
      UPDATE whatsapp_session SET
        session_data = ?,
        is_connected = ?,
        phone_number = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(sessionData, isConnected ? 1 : 0, phoneNumber);
  },

  clearSession: () => {
    return db.prepare(`
      UPDATE whatsapp_session SET
        session_data = NULL,
        is_connected = 0,
        phone_number = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run();
  },

  // ========== SETTINGS ==========

  getSetting: (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value;
  },

  setSetting: (key, value) => {
    return db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  },

  // ========== STATS ==========

  incrementStats: (registered, notRegistered) => {
    const today = new Date().toISOString().split('T')[0];
    return db.prepare(`
      INSERT INTO stats (date, total_checks, registered_count, not_registered_count, unique_users)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(date) DO UPDATE SET
        total_checks = total_checks + ?,
        registered_count = registered_count + ?,
        not_registered_count = not_registered_count + ?
    `).run(today, registered + notRegistered, registered, notRegistered,
           registered + notRegistered, registered, notRegistered);
  },

  getStats: (days = 7) => {
    return db.prepare('SELECT * FROM stats ORDER BY date DESC LIMIT ?').all(days);
  },

  getTotalStats: () => {
    return db.prepare(`
      SELECT
        SUM(total_checks) as total_checks,
        SUM(registered_count) as registered_count,
        SUM(not_registered_count) as not_registered_count
      FROM stats
    `).get();
  },

  // ========== NUMBER POOL ==========

  addNumber: (userId, phoneNumber) => {
    return db.prepare('INSERT INTO number_pool (user_id, phone_number) VALUES (?, ?)').run(userId, phoneNumber);
  },

  getNextNumber: (userId) => {
    const number = db.prepare(`
      SELECT * FROM number_pool
      WHERE user_id = ? AND is_used = 0
      ORDER BY id ASC
      LIMIT 1
    `).get(userId);

    if (number) {
      db.prepare('UPDATE number_pool SET is_used = 1 WHERE id = ?').run(number.id);
    }

    return number;
  },

  getNumberCount: (userId) => {
    const result = db.prepare('SELECT COUNT(*) as count FROM number_pool WHERE user_id = ? AND is_used = 0').get(userId);
    return result?.count || 0;
  },

  // ========== MULTI-ACCOUNT WHATSAPP ==========

  // Saare accounts lo
  getAllAccounts: () => {
    return db.prepare('SELECT * FROM wa_accounts ORDER BY id ASC').all();
  },

  // Ek account lo
  getAccount: (accountId) => {
    return db.prepare('SELECT * FROM wa_accounts WHERE account_id = ?').get(accountId);
  },

  // Naya account register karo
  addAccount: (accountId, label = null) => {
    return db.prepare(`
      INSERT OR IGNORE INTO wa_accounts (account_id, label)
      VALUES (?, ?)
    `).run(accountId, label || accountId);
  },

  // Account delete karo
  removeAccount: (accountId) => {
    return db.prepare('DELETE FROM wa_accounts WHERE account_id = ?').run(accountId);
  },

  // Connected status update karo
  setAccountConnected: (accountId, isConnected, phoneNumber = null) => {
    const now = new Date().toISOString();
    return db.prepare(`
      UPDATE wa_accounts SET
        is_connected = ?,
        phone_number = COALESCE(?, phone_number),
        last_connected = CASE WHEN ? = 1 THEN ? ELSE last_connected END
      WHERE account_id = ?
    `).run(isConnected ? 1 : 0, phoneNumber, isConnected ? 1 : 0, now, accountId);
  },

  // Admin se enable/disable karo
  setAccountEnabled: (accountId, enabled) => {
    return db.prepare('UPDATE wa_accounts SET is_enabled = ? WHERE account_id = ?').run(enabled ? 1 : 0, accountId);
  },

  // Ban count badhao (jab loggedOut disconnect aaye)
  incrementBanCount: (accountId) => {
    return db.prepare('UPDATE wa_accounts SET ban_count = ban_count + 1, is_enabled = 0 WHERE account_id = ?').run(accountId);
  },

  // Checks count badhao
  incrementAccountChecks: (accountId, count = 1) => {
    return db.prepare('UPDATE wa_accounts SET total_checks = total_checks + ? WHERE account_id = ?').run(count, accountId);
  },

  // Sirf connected + enabled accounts lo — load balancing ke liye
  // Least checks wala pehle aayega (round-robin style)
  getActiveAccounts: () => {
    return db.prepare(`
      SELECT * FROM wa_accounts
      WHERE is_connected = 1 AND is_enabled = 1
      ORDER BY total_checks ASC
    `).all();
  },

  // Label update karo
  updateAccountLabel: (accountId, label) => {
    return db.prepare('UPDATE wa_accounts SET label = ? WHERE account_id = ?').run(label, accountId);
  },
};