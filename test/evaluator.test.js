const test = require("node:test");
const assert = require("node:assert/strict");

const {
  scoreResponse,
  buildImprovedVersion,
  buildPersonalizedGoodExampleFallback,
} = require("../src/evaluator");

const scenario = {
  title: "Клиент: Дорого",
  goodTemplates: [
    "Понимаю вопрос по бюджету. Предлагаю поэтапный запуск, чтобы снизить риск.",
    "Скидку на тот же объем не даю, но могу адаптировать этапы под ваш приоритет.",
  ],
};

test("scoreResponse rewards empathy/question/value and level", () => {
  const novice = scoreResponse(
    "Понимаю ваш вопрос. Давайте зафиксируем приоритет и сроки, чтобы выбрать подходящий этап?",
    "novice",
    [{ title: "r1" }]
  );
  assert.ok(novice.score >= 4);
  assert.deepEqual(novice.appliedRules, ["r1"]);
});

test("buildImprovedVersion includes profile personalization", () => {
  const text = buildImprovedVersion(
    "ok",
    scenario,
    "mid",
    { niche: "мобильная разработка", goal: "увеличить чек" }
  );
  assert.match(text, /мобильная разработка/i);
  assert.match(text, /увеличить чек/i);
});

test("good example fallback includes profile and template", () => {
  const out = buildPersonalizedGoodExampleFallback(
    scenario,
    1,
    { niche: "telegram-боты", goal: "меньше скидок" }
  );
  assert.match(out, /telegram-боты/i);
  assert.match(out, /меньше скидок/i);
  assert.match(out, /Опорная формулировка/i);
});

test("good example fallback returns base template without profile", () => {
  const out = buildPersonalizedGoodExampleFallback(scenario, 0, { niche: "", goal: "" });
  assert.equal(out, scenario.goodTemplates[0]);
});

