/**
 * Live-проверка персонализации сценариев (тратит токены).
 * Запуск:
 *   node scripts/llm-personalization-live.js
 *
 * Рекомендуется вручную, не в CI.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { generatePersonalizedScenario, isLlmEnabled } = require("../src/llm");

const baseScenario = {
  id: "discount",
  title: "Клиент: Просит скидку",
  clientMessage: "Сделаете скидку?",
  goal: "Сохранить ценность и предложить альтернативу без демпинга.",
};

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function pickScenarioSignature(s) {
  return `${s.scenario_title}|${s.client_message}|${s.trainer_goal}|${s.level_challenge}`;
}

function normalize(text) {
  return String(text || "").toLowerCase();
}

function hasAny(text, tokens) {
  const n = normalize(text);
  return tokens.some((t) => n.includes(t));
}

async function main() {
  if (!isLlmEnabled()) {
    console.error("OPENAI_API_KEY не найден. Пропускаю live-проверку.");
    process.exit(2);
  }

  const profileA = { niche: "мобильная разработка", goal: "увеличить чек", completed: true };
  const profileB = { niche: "telegram-боты для e-commerce", goal: "меньше скидок", completed: true };

  const aMid = await generatePersonalizedScenario({
    profile: profileA,
    level: "mid",
    baseScenario,
    dialogHistory: [],
  });
  const bMid = await generatePersonalizedScenario({
    profile: profileB,
    level: "mid",
    baseScenario,
    dialogHistory: [],
  });
  const aNovice = await generatePersonalizedScenario({
    profile: profileA,
    level: "novice",
    baseScenario,
    dialogHistory: [],
  });
  const aAdvanced = await generatePersonalizedScenario({
    profile: profileA,
    level: "advanced",
    baseScenario,
    dialogHistory: [],
  });

  for (const [name, s] of [
    ["aMid", aMid],
    ["bMid", bMid],
    ["aNovice", aNovice],
    ["aAdvanced", aAdvanced],
  ]) {
    if (!s || s.refusal) fail(`${name}: empty/refusal payload`);
  }

  const sigAMid = pickScenarioSignature(aMid);
  const sigBMid = pickScenarioSignature(bMid);
  if (sigAMid === sigBMid) {
    fail("niche/goal variation produced identical scenario");
  }

  const lvl1 = (aNovice.level_challenge || "").trim();
  const lvl2 = (aAdvanced.level_challenge || "").trim();
  if (!lvl1 || !lvl2 || lvl1 === lvl2) {
    fail("level variation did not change level_challenge");
  }

  // Жестче: в результате должны быть признаки цели/ниши.
  const aCombined =
    `${aMid.trainer_goal} ${aMid.level_challenge} ` +
    `${aMid.context?.project_hint || ""} ${aMid.context?.client_type || ""} ${aMid.client_message || ""}`;
  const bCombined =
    `${bMid.trainer_goal} ${bMid.level_challenge} ` +
    `${bMid.context?.project_hint || ""} ${bMid.context?.client_type || ""} ${bMid.client_message || ""}`;

  const goalATokens = ["чек", "средн", "апсел", "дорог", "пакет", "стоим"];
  const goalBTokens = ["скид", "демп", "марж", "ценност", "альтернатив"];
  const nicheATokens = ["мобил", "прилож", "ios", "android"];
  const nicheBTokens = ["telegram", "бот", "e-commerce", "магазин", "заказ"];

  if (!hasAny(aCombined, goalATokens)) {
    fail("profileA goal is not reflected in trainer_goal/level_challenge");
  }
  if (!hasAny(bCombined, goalBTokens)) {
    fail("profileB goal is not reflected in trainer_goal/level_challenge");
  }
  if (!hasAny(aCombined, nicheATokens)) {
    fail("profileA niche is not reflected in scenario text");
  }
  if (!hasAny(bCombined, nicheBTokens)) {
    fail("profileB niche is not reflected in scenario text");
  }

  console.log("OK: live personalization checks passed");
  console.log("- aMid trainer_goal:", aMid.trainer_goal);
  console.log("- bMid trainer_goal:", bMid.trainer_goal);
  console.log("- novice challenge:", aNovice.level_challenge);
  console.log("- advanced challenge:", aAdvanced.level_challenge);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

