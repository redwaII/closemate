const { pool } = require("./db");

async function ensureBusinessSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scenarios (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      objection_label TEXT NOT NULL,
      client_message TEXT NOT NULL,
      goal TEXT NOT NULL,
      context JSONB NOT NULL,
      level_challenge JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS good_templates (
      id SERIAL PRIMARY KEY,
      scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      template_text TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS evaluation_rules (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL
    );
  `);
}

async function getBusinessData() {
  const scenarioRows = await pool.query(
    `SELECT id, title, objection_label, client_message, goal, context, level_challenge FROM scenarios ORDER BY id`
  );
  const templateRows = await pool.query(
    `SELECT scenario_id, template_text FROM good_templates ORDER BY id`
  );
  const ruleRows = await pool.query(
    `SELECT id, title, description FROM evaluation_rules ORDER BY id`
  );

  const templatesByScenario = new Map();
  for (const row of templateRows.rows) {
    if (!templatesByScenario.has(row.scenario_id)) {
      templatesByScenario.set(row.scenario_id, []);
    }
    templatesByScenario.get(row.scenario_id).push(row.template_text);
  }

  const scenarios = scenarioRows.rows.map((row) => ({
    id: row.id,
    title: row.title,
    objectionLabel: row.objection_label,
    clientMessage: row.client_message,
    goal: row.goal,
    context: row.context,
    levelChallenge: row.level_challenge,
    goodTemplates: templatesByScenario.get(row.id) || [],
  }));

  return {
    scenarios,
    evaluationRules: ruleRows.rows,
  };
}

module.exports = {
  ensureBusinessSchema,
  getBusinessData,
};
