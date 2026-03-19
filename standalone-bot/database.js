// ════════════════════════════════════════════════════════════════════════════
//  Database — Supabase as primary store (persists across Render redeploys)
//  Falls back to in-memory cache for reads to keep it fast
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SB_SERVICE_KEY) {
  throw new Error('SUPABASE_URL and SB_SERVICE_KEY must be set!');
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SB_SERVICE_KEY);

// ─── In-memory caches (populated at boot, kept in sync) ──────────────────────
const _users    = new Map(); // telegram_id → user object
const _settings = new Map(); // key → value
const _accounts = new Map(); // account_id → account object
const _stats    = new Map(); // date → stats object
const _fsub     = [];        // array of fsub channels
const _referLog = new Set(); // referred_id (to dedup)

// ─── BOOT: load everything from Supabase ─────────────────────────────────────
async function init() {
  try {
    const [users, settings, accounts, stats, fsub, referLog] = await Promise.all([
      sb.from('users').select('*'),
      sb.from('bot_settings').select('*'),
      sb.from('wa_accounts').select('*').order('id'),
      sb.from('bot_stats').select('*'),
      sb.from('fsub_channels').select('*').order('id'),
      sb.from('refer_log').select('referred_id'),
    ]);

    (users.data || []).forEach(u => _users.set(u.telegram_id, u));
    (settings.data || []).forEach(s => _settings.set(s.key, s.value));
    (accounts.data || []).forEach(a => _accounts.set(a.account_id, a));
    (stats.data || []).forEach(s => _stats.set(s.date, s));
    _fsub.length = 0; _fsub.push(...(fsub.data || []));
    (referLog.data || []).forEach(r => _referLog.add(r.referred_id));

    console.log(`[DB] Loaded: ${_users.size} users, ${_accounts.size} accounts, ${_settings.size} settings`);
  } catch (e) {
    console.error('[DB] Init error:', e.message);
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function generateReferCode(telegramId) {
  return 'REF' + telegramId.toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

function isPremActive(u) {
  if (!u || !u.is_premium) return false;
  if (!u.premium_until) return true;
  return new Date(u.premium_until) > new Date();
}

// ─── USERS ───────────────────────────────────────────────────────────────────
module.exports = {

  init,

  getUser(telegramId) {
    return _users.get(telegramId) || null;
  },

  createUser(telegramId, username, firstName, role = 'user') {
    const existing = _users.get(telegramId);
    if (existing) {
      const updated = { ...existing, username, first_name: firstName, last_active: new Date().toISOString() };
      _users.set(telegramId, updated);
      sb.from('users').update({ username, first_name: firstName, last_active: new Date().toISOString() })
        .eq('telegram_id', telegramId).then(() => {}).catch(() => {});
      return false;
    }
    const referCode = generateReferCode(telegramId);
    const newUser = {
      telegram_id: telegramId, username, first_name: firstName,
      role, is_blocked: 0, is_allowed: 0, is_premium: 0,
      premium_until: null, numbers_checked: 0,
      daily_checks: 0, daily_reset: new Date().toISOString().split('T')[0],
      refer_code: referCode, referred_by: null,
      refer_count: 0, bonus_checks: 0,
      joined_at: new Date().toISOString(), last_active: new Date().toISOString(),
    };
    _users.set(telegramId, newUser);
    sb.from('users').insert(newUser).then(() => {}).catch(() => {});
    return true;
  },

  getAllUsers() {
    return [..._users.values()].sort((a, b) => new Date(b.joined_at) - new Date(a.joined_at));
  },

  getAdmins() {
    return [..._users.values()].filter(u => ['admin','owner'].includes(u.role));
  },

  updateRole(telegramId, role) {
    const u = _users.get(telegramId);
    if (u) { u.role = role; _users.set(telegramId, u); }
    sb.from('users').update({ role }).eq('telegram_id', telegramId).then(() => {}).catch(() => {});
  },

  blockUser(telegramId, blocked) {
    const u = _users.get(telegramId);
    if (u) { u.is_blocked = blocked ? 1 : 0; _users.set(telegramId, u); }
    sb.from('users').update({ is_blocked: blocked ? 1 : 0 }).eq('telegram_id', telegramId).then(() => {}).catch(() => {});
  },

  setPremium(telegramId, until) {
    const u = _users.get(telegramId);
    const val = until ? until.toISOString() : null;
    if (u) { u.is_premium = 1; u.is_allowed = 1; u.premium_until = val; _users.set(telegramId, u); }
    sb.from('users').update({ is_premium: 1, is_allowed: 1, premium_until: val }).eq('telegram_id', telegramId).then(() => {}).catch(() => {});
  },

  removePremium(telegramId) {
    const u = _users.get(telegramId);
    if (u) { u.is_premium = 0; u.premium_until = null; _users.set(telegramId, u); }
    sb.from('users').update({ is_premium: 0, premium_until: null }).eq('telegram_id', telegramId).then(() => {}).catch(() => {});
  },

  isPremiumActive(telegramId) {
    return isPremActive(_users.get(telegramId));
  },

  getRemainingChecks(telegramId, freeLimit, premiumLimit) {
    const u = _users.get(telegramId);
    if (!u) return { limit: freeLimit, used: 0, remaining: freeLimit, isPremium: false, isVip: false };
    const today  = new Date().toISOString().split('T')[0];
    const used   = u.daily_reset === today ? (u.daily_checks || 0) : 0;
    const prem   = isPremActive(u);
    const isVip  = prem && u.premium_plan === 'vip';
    const bonus  = u.bonus_checks || 0;
    // VIP = unlimited (999999)
    const limit  = isVip ? 999999 : (prem ? premiumLimit : freeLimit);
    const remaining = isVip ? 999999 : Math.max(0, limit + bonus - used);
    return { limit, used, remaining, isPremium: prem, isVip, bonus };
  },

  incrementDailyChecks(telegramId, count) {
    const today = new Date().toISOString().split('T')[0];
    const u = _users.get(telegramId);
    if (!u) return;
    const newUsed = u.daily_reset === today ? (u.daily_checks || 0) + count : count;
    u.daily_checks    = newUsed;
    u.daily_reset     = today;
    u.numbers_checked = (u.numbers_checked || 0) + count;
    u.last_active     = new Date().toISOString();
    _users.set(telegramId, u);
    sb.from('users').update({
      daily_checks: newUsed, daily_reset: today,
      numbers_checked: u.numbers_checked,
      last_active: u.last_active,
    }).eq('telegram_id', telegramId).then(() => {}).catch(() => {});
  },

  // ─── REFERRALS ──────────────────────────────────────────────────────────────

  getUserByReferCode(code) {
    return [..._users.values()].find(u => u.refer_code === code) || null;
  },

  applyReferral(referrerId, referredId, bonusChecks = 10) {
    if (_referLog.has(referredId)) return false;
    _referLog.add(referredId);
    const referrer = _users.get(referrerId);
    if (referrer) {
      referrer.refer_count  = (referrer.refer_count || 0) + 1;
      referrer.bonus_checks = (referrer.bonus_checks || 0) + bonusChecks;
      _users.set(referrerId, referrer);
      sb.from('users').update({ refer_count: referrer.refer_count, bonus_checks: referrer.bonus_checks })
        .eq('telegram_id', referrerId).then(() => {}).catch(() => {});
    }
    const referred = _users.get(referredId);
    if (referred) {
      referred.referred_by = referrerId;
      _users.set(referredId, referred);
      sb.from('users').update({ referred_by: referrerId }).eq('telegram_id', referredId).then(() => {}).catch(() => {});
    }
    sb.from('refer_log').insert({ referrer_id: referrerId, referred_id: referredId, bonus_given: bonusChecks }).then(() => {}).catch(() => {});
    return true;
  },

  // ─── SETTINGS ───────────────────────────────────────────────────────────────

  getSetting(key) {
    return _settings.get(key) || null;
  },

  setSetting(key, value) {
    _settings.set(key, value);
    sb.from('bot_settings').upsert({ key, value }, { onConflict: 'key' }).then(() => {}).catch(() => {});
  },

  // ─── STATS ──────────────────────────────────────────────────────────────────

  incrementStats(registered, notRegistered) {
    const today = new Date().toISOString().split('T')[0];
    const total = registered + notRegistered;
    const s = _stats.get(today) || { date: today, total_checks: 0, registered_count: 0, not_registered_count: 0, unique_users: 0 };
    s.total_checks         += total;
    s.registered_count     += registered;
    s.not_registered_count += notRegistered;
    _stats.set(today, s);
    sb.from('bot_stats').upsert(s, { onConflict: 'date' }).then(() => {}).catch(() => {});
  },

  getTotalStats() {
    const all = [..._stats.values()];
    return {
      total_checks:         all.reduce((s, r) => s + (r.total_checks || 0), 0),
      registered_count:     all.reduce((s, r) => s + (r.registered_count || 0), 0),
      not_registered_count: all.reduce((s, r) => s + (r.not_registered_count || 0), 0),
    };
  },

  getStatsHistory(days = 7) {
    return [..._stats.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, days);
  },

  // ─── NUMBER POOL ────────────────────────────────────────────────────────────

  async addNumber(userId, phoneNumber) {
    await sb.from('number_pool').insert({ user_id: userId, phone_number: phoneNumber });
  },

  async getNextNumber(userId) {
    const { data } = await sb.from('number_pool')
      .select('*').eq('user_id', userId).eq('is_used', 0).order('id').limit(1);
    if (!data || !data.length) return null;
    await sb.from('number_pool').update({ is_used: 1 }).eq('id', data[0].id);
    return data[0];
  },

  async getNumberCount(userId) {
    const { count } = await sb.from('number_pool')
      .select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('is_used', 0);
    return count || 0;
  },

  // ─── WA ACCOUNTS ────────────────────────────────────────────────────────────

  getAllAccounts() {
    return [..._accounts.values()].sort((a, b) => {
      if (a.account_type !== b.account_type) return a.account_type.localeCompare(b.account_type);
      return (a.id || 0) - (b.id || 0);
    });
  },

  getAccount(accountId) {
    return _accounts.get(accountId) || null;
  },

  addAccount(accountId, label, type = 'checker') {
    if (_accounts.has(accountId)) return;
    const acct = { account_id: accountId, label: label || accountId, account_type: type, is_enabled: 1, is_connected: 0, total_checks: 0, ban_count: 0 };
    _accounts.set(accountId, acct);
    sb.from('wa_accounts').upsert(acct, { onConflict: 'account_id' }).then(r => {
      if (r.data?.[0]) _accounts.set(accountId, { ...acct, ...r.data[0] });
    }).catch(() => {});
  },

  removeAccount(accountId) {
    _accounts.delete(accountId);
    sb.from('wa_accounts').delete().eq('account_id', accountId).then(() => {}).catch(() => {});
  },

  setAccountConnected(accountId, isConnected, phoneNumber = null) {
    const a = _accounts.get(accountId);
    if (a) {
      a.is_connected = isConnected ? 1 : 0;
      if (phoneNumber) a.phone_number = phoneNumber;
      if (isConnected) a.last_connected = new Date().toISOString();
      _accounts.set(accountId, a);
    }
    const upd = { is_connected: isConnected ? 1 : 0 };
    if (phoneNumber) upd.phone_number = phoneNumber;
    if (isConnected) upd.last_connected = new Date().toISOString();
    sb.from('wa_accounts').update(upd).eq('account_id', accountId).then(() => {}).catch(() => {});
  },

  setAccountEnabled(accountId, enabled) {
    const a = _accounts.get(accountId);
    if (a) { a.is_enabled = enabled ? 1 : 0; _accounts.set(accountId, a); }
    sb.from('wa_accounts').update({ is_enabled: enabled ? 1 : 0 }).eq('account_id', accountId).then(() => {}).catch(() => {});
  },

  setAccountType(accountId, type) {
    const a = _accounts.get(accountId);
    if (a) { a.account_type = type; _accounts.set(accountId, a); }
    sb.from('wa_accounts').update({ account_type: type }).eq('account_id', accountId).then(() => {}).catch(() => {});
  },

  incrementBanCount(accountId) {
    const a = _accounts.get(accountId);
    if (a) { a.ban_count = (a.ban_count || 0) + 1; a.is_enabled = 0; a.is_connected = 0; _accounts.set(accountId, a); }
    sb.from('wa_accounts').update({ ban_count: (a?.ban_count || 1), is_enabled: 0, is_connected: 0 })
      .eq('account_id', accountId).then(() => {}).catch(() => {});
  },

  incrementAccountChecks(accountId, count = 1) {
    const a = _accounts.get(accountId);
    if (a) { a.total_checks = (a.total_checks || 0) + count; _accounts.set(accountId, a); }
    sb.from('wa_accounts').update({ total_checks: (a?.total_checks || count) })
      .eq('account_id', accountId).then(() => {}).catch(() => {});
  },

  getActiveCheckerAccounts() {
    return [..._accounts.values()].filter(a => a.is_connected && a.is_enabled && a.account_type === 'checker');
  },

  getEnabledBackupAccounts() {
    return [..._accounts.values()].filter(a => a.is_enabled && a.account_type === 'backup');
  },

  // ─── FSUB CHANNELS ──────────────────────────────────────────────────────────

  getAllFsubChannels() { return [..._fsub]; },

  addFsubChannel(channelId, title, link) {
    const existing = _fsub.findIndex(c => c.channel_id === channelId);
    const obj = { channel_id: channelId, title: title || channelId, link: link || '' };
    if (existing >= 0) _fsub[existing] = { ..._fsub[existing], ...obj };
    else _fsub.push(obj);
    sb.from('fsub_channels').upsert(obj, { onConflict: 'channel_id' }).then(() => {}).catch(() => {});
  },

  removeFsubChannel(channelId) {
    const i = _fsub.findIndex(c => c.channel_id === channelId);
    if (i >= 0) _fsub.splice(i, 1);
    sb.from('fsub_channels').delete().eq('channel_id', channelId).then(() => {}).catch(() => {});
  },

  updateFsubChannel(channelId, title, link) {
    const obj = _fsub.find(c => c.channel_id === channelId);
    if (obj) { obj.title = title; obj.link = link; }
    sb.from('fsub_channels').update({ title, link }).eq('channel_id', channelId).then(() => {}).catch(() => {});
  },

  // ─── REDEEM CODES ────────────────────────────────────────────────────────────

  async createRedeemCode(code, checks, maxUses, createdBy) {
    const { data, error } = await sb.from('redeem_codes').insert({
      code: code.toUpperCase(),
      checks,
      max_uses:   maxUses || 1,
      used_count: 0,
      is_active:  true,
      created_by: createdBy,
    }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async getRedeemCode(code) {
    const { data } = await sb.from('redeem_codes')
      .select('*').eq('code', code.toUpperCase()).eq('is_active', true).single();
    return data;
  },

  async getAllRedeemCodes() {
    const { data } = await sb.from('redeem_codes').select('*').order('created_at', { ascending: false });
    return data || [];
  },

  async redeemCode(code, userId) {
    // Check if user already redeemed this code
    const { data: already } = await sb.from('redeem_log')
      .select('id').eq('code', code.toUpperCase()).eq('user_id', userId).single();
    if (already) return { success: false, reason: 'already_redeemed' };

    // Get code
    const { data: codeRow } = await sb.from('redeem_codes')
      .select('*').eq('code', code.toUpperCase()).eq('is_active', true).single();
    if (!codeRow) return { success: false, reason: 'invalid_code' };
    if (codeRow.used_count >= codeRow.max_uses) return { success: false, reason: 'expired' };

    // Apply bonus checks
    const u = _users.get(userId);
    if (u) {
      u.bonus_checks = (u.bonus_checks || 0) + codeRow.checks;
      _users.set(userId, u);
      await sb.from('users').update({ bonus_checks: u.bonus_checks }).eq('telegram_id', userId);
    }

    // Log redeem
    await sb.from('redeem_log').insert({ code: code.toUpperCase(), user_id: userId, checks: codeRow.checks });

    // Increment used count, deactivate if max reached
    const newCount = codeRow.used_count + 1;
    await sb.from('redeem_codes').update({
      used_count: newCount,
      is_active: newCount < codeRow.max_uses,
    }).eq('code', code.toUpperCase());

    return { success: true, checks: codeRow.checks };
  },

  async deleteRedeemCode(code) {
    await sb.from('redeem_codes').delete().eq('code', code.toUpperCase());
  },

};