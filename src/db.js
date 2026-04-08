const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.PGHOST || undefined,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  database: process.env.PGDATABASE || undefined,
  user: process.env.PGUSER || undefined,
  password: process.env.PGPASSWORD || undefined,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
});

module.exports = {
  pool,
};
