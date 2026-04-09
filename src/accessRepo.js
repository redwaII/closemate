const { pool } = require("./db");

const PLAN_FREE = "free";
const PLAN_PRO = "pro";
const useMemoryStore = process.env.NODE_ENV === "test";
const memoryAccess = new Map();

async function ensureAccessSchema() {
  if (useMemoryStore) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_access (
      user_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'free',
      plan_type TEXT NOT NULL DEFAULT 'one_time',
      source TEXT NOT NULL DEFAULT 'manual',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      expires_at TIMESTAMPTZ NULL,
      activated_at TIMESTAMPTZ NULL,
      activated_by TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT user_access_plan_check CHECK (plan IN ('free', 'pro')),
      CONSTRAINT user_access_plan_type_check CHECK (plan_type IN ('one_time', 'subscription'))
    );
  `);
}

function normalizeAccessRow(row, userId) {
  if (!row) {
    return {
      userId,
      plan: PLAN_FREE,
      planType: "one_time",
      source: "manual",
      isActive: true,
      expiresAt: null,
    };
  }
  const isExpired = row.expires_at ? new Date(row.expires_at).getTime() <= Date.now() : false;
  const active = Boolean(row.is_active) && !isExpired;
  const plan = active ? row.plan : PLAN_FREE;
  return {
    userId: row.user_id,
    plan,
    planType: row.plan_type,
    source: row.source,
    isActive: active,
    expiresAt: row.expires_at || null,
  };
}

async function getOrCreateUserAccess(userId) {
  if (useMemoryStore) {
    if (!memoryAccess.has(userId)) {
      memoryAccess.set(userId, {
        user_id: userId,
        plan: PLAN_FREE,
        plan_type: "one_time",
        source: "manual",
        is_active: true,
        expires_at: null,
      });
    }
    return normalizeAccessRow(memoryAccess.get(userId), userId);
  }
  const res = await pool.query(
    `INSERT INTO user_access (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
     RETURNING user_id, plan, plan_type, source, is_active, expires_at`,
    [userId]
  );
  return normalizeAccessRow(res.rows[0], userId);
}

async function getUserAccess(userId) {
  if (useMemoryStore) {
    return normalizeAccessRow(memoryAccess.get(userId), userId);
  }
  const res = await pool.query(
    `SELECT user_id, plan, plan_type, source, is_active, expires_at
     FROM user_access
     WHERE user_id = $1`,
    [userId]
  );
  return normalizeAccessRow(res.rows[0], userId);
}

async function userExists(userId) {
  if (useMemoryStore) return memoryAccess.has(userId);
  const res = await pool.query(`SELECT 1 FROM user_access WHERE user_id = $1`, [userId]);
  return res.rowCount > 0;
}

async function setUserPlan({
  userId,
  plan,
  adminId,
  source = "manual",
  planType = "one_time",
  isActive = true,
  expiresAt = null,
}) {
  const safePlan = plan === PLAN_PRO ? PLAN_PRO : PLAN_FREE;
  const safePlanType = planType === "subscription" ? "subscription" : "one_time";
  if (useMemoryStore) {
    const row = {
      user_id: userId,
      plan: safePlan,
      plan_type: safePlanType,
      source,
      is_active: isActive,
      expires_at: expiresAt,
    };
    memoryAccess.set(userId, row);
    return normalizeAccessRow(row, userId);
  }
  const activatedAt = safePlan === PLAN_PRO && isActive ? new Date() : null;
  const res = await pool.query(
    `INSERT INTO user_access (
       user_id, plan, plan_type, source, is_active, expires_at, activated_at, activated_by, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       plan = EXCLUDED.plan,
       plan_type = EXCLUDED.plan_type,
       source = EXCLUDED.source,
       is_active = EXCLUDED.is_active,
       expires_at = EXCLUDED.expires_at,
       activated_at = EXCLUDED.activated_at,
       activated_by = EXCLUDED.activated_by,
       updated_at = NOW()
     RETURNING user_id, plan, plan_type, source, is_active, expires_at`,
    [userId, safePlan, safePlanType, source, isActive, expiresAt, activatedAt, adminId || null]
  );
  return normalizeAccessRow(res.rows[0], userId);
}

module.exports = {
  PLAN_FREE,
  PLAN_PRO,
  ensureAccessSchema,
  getOrCreateUserAccess,
  getUserAccess,
  userExists,
  setUserPlan,
  _test: {
    memoryAccess,
  },
};

