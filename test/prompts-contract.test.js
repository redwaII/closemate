const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SYSTEM_SCENARIO_GENERATION,
  SYSTEM_FEEDBACK,
  buildScenarioUserMessage,
} = require("../src/prompts");

test("scenario prompt contract mentions goal personalization", () => {
  assert.match(SYSTEM_SCENARIO_GENERATION, /цель месяца/i);
  assert.match(SYSTEM_SCENARIO_GENERATION, /trainer_goal/i);
  assert.match(SYSTEM_SCENARIO_GENERATION, /level_challenge/i);
});

test("feedback prompt contract includes good_example field", () => {
  assert.match(SYSTEM_FEEDBACK, /good_example/);
  assert.match(SYSTEM_FEEDBACK, /персонализирован/i);
});

test("scenario user message contains niche and goal", () => {
  const msg = buildScenarioUserMessage({
    niche: "мобильная разработка",
    goal: "увеличить чек",
    level: "mid",
    baseScenario: {
      id: "discount",
      title: "Клиент: Просит скидку",
      clientMessage: "Сделаете скидку?",
      goal: "Сохранить ценность",
    },
  });
  assert.match(msg, /мобильная разработка/i);
  assert.match(msg, /увеличить чек/i);
  assert.match(msg, /discount/i);
});

