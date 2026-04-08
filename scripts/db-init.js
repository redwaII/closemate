require("dotenv").config();

const { ensureBusinessSchema } = require("../src/businessDataRepo");
const { pool } = require("../src/db");

async function run() {
  await ensureBusinessSchema();
  console.log("Business schema is ready.");
}

run()
  .catch((err) => {
    console.error("Failed to initialize DB:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
