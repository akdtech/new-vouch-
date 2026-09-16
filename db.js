"use strict";

const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: connectionString || undefined,
  ssl: String(process.env.DATABASE_SSL || "false").toLowerCase() === "true"
    ? { rejectUnauthorized: false }
    : undefined,
  max: Number(process.env.DATABASE_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

let initialized = false;
let initializing = null;

async function ensureVouchDatabase() {
  if (initialized) return;
  if (initializing) return initializing;

  initializing = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vouches (
        id BIGSERIAL PRIMARY KEY,
        voucher_discord_id TEXT NOT NULL,
        vouched_discord_id TEXT NOT NULL,
        guild_discord_id TEXT NOT NULL,
        stars SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
        review TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE vouches
        ADD COLUMN IF NOT EXISTS guild_discord_id TEXT;

      UPDATE vouches
        SET guild_discord_id = 'unknown'
        WHERE guild_discord_id IS NULL;

      ALTER TABLE vouches
        ALTER COLUMN guild_discord_id SET NOT NULL;

      CREATE INDEX IF NOT EXISTS vouches_vouched_discord_id_idx
        ON vouches(vouched_discord_id);

      CREATE INDEX IF NOT EXISTS vouches_guild_discord_id_idx
        ON vouches(guild_discord_id);

      CREATE INDEX IF NOT EXISTS vouches_guild_vouched_idx
        ON vouches(guild_discord_id, vouched_discord_id);
    `);

    initialized = true;
  })();

  try {
    await initializing;
  } finally {
    initializing = null;
  }
}

async function query(text, params) {
  await ensureVouchDatabase();
  return pool.query(text, params);
}

module.exports = {
  pool,
  query,
  ensureVouchDatabase
};
