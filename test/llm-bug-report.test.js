const test = require("node:test");
const assert = require("node:assert/strict");

test("evaluateBugReport uses heuristic fallback without API key", async () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete require.cache[require.resolve("../src/llm")];
  const { evaluateBugReport } = require("../src/llm");

  const bad = await evaluateBugReport("🙂🙂🙂");
  assert.equal(bad.accept, false);

  const good = await evaluateBugReport("не работает кнопка выбрать сценарий");
  assert.equal(good.accept, true);

  if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  delete require.cache[require.resolve("../src/llm")];
});

