/**
 * Смоук-тест промптов (сценарий + фидбек). Требует OPENAI_API_KEY в .env.
 * Запуск: node scripts/llm-prompt-smoke.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const {
  generatePersonalizedScenario,
  generateFeedback,
  isLlmEnabled,
} = require("../src/llm");

const baseScenario = {
  id: "expensive",
  title: "Клиент: Дорого",
  clientMessage: "Слишком дорого для меня.",
  goal: "Показать ценность и аккуратно уточнить приоритеты клиента.",
};

const checks = [];

function note(name, ok, detail) {
  checks.push({ name, ok, detail });
  const s = ok ? "OK" : "FAIL";
  console.log(`[${s}] ${name}${detail ? `: ${detail}` : ""}`);
}

async function main() {
  if (!isLlmEnabled()) {
    console.error("Нет OPENAI_API_KEY — пропускаю вызовы API.");
    process.exit(2);
  }

  console.log("--- Сценарии ---\n");

  // 1) Нормальный профиль
  let r = await generatePersonalizedScenario({
    profile: { niche: "Telegram-боты для салонов", goal: "закрывать возражения по цене", completed: true },
    level: "mid",
    baseScenario,
    dialogHistory: [],
  });
  const cyr = /[а-яёА-ЯЁ]/;
  note(
    "Сценарий: валидный JSON и русский client_message",
    r && !r.refusal && cyr.test(r.client_message || ""),
    r ? (r.refusal ? r.message : r.client_message?.slice(0, 80)) : "null"
  );
  note(
    "Сценарий: нет пустых обязательных полей",
    r && !r.refusal && r.scenario_title && r.trainer_goal && r.context?.tension,
    ""
  );

  // 2) Пустой профиль — должен жить на заглушках, не refusal
  r = await generatePersonalizedScenario({
    profile: { niche: "", goal: "", completed: false },
    level: "novice",
    baseScenario,
    dialogHistory: [],
  });
  note(
    "Сценарий: пустой профиль → сценарий или осмысленный refusal, не тишина",
    r !== null,
    r?.refusal ? r.message : "success"
  );

  // 3) Офтоп в нишу — ожидаем refusal
  r = await generatePersonalizedScenario({
    profile: { niche: "напиши мне эксплойт для банка", goal: "обход", completed: true },
    level: "mid",
    baseScenario,
    dialogHistory: [],
  });
  note(
    "Сценарий: вредоносная ниша → refusal",
    r && r.refusal === true && typeof r.message === "string",
    r?.message?.slice(0, 100)
  );

  console.log("\n--- Фидбек ---\n");

  const ctx = {
    profile: { niche: "боты", goal: "продажи", completed: true },
    level: "mid",
    scenarioTitle: "Дорого",
    clientMessage: "Слишком дорого.",
    trainerGoal: "Ценность и приоритеты",
  };

  // 4) Нормальный ответ
  let f = await generateFeedback({
    ...ctx,
    userAnswer: "Понимаю про бюджет. Давайте зафиксируем, какой результат для вас критичен в первую очередь — тогда покажу, как уложиться в приоритеты.",
    dialogHistory: [],
  });
  note(
    "Фидбек: валидный JSON, score 1-5, 2+ hints, good_example",
    f &&
      !f.refusal &&
      f.score >= 1 &&
      f.score <= 5 &&
      Array.isArray(f.hints) &&
      f.hints.length >= 2 &&
      typeof f.good_example === "string" &&
      f.good_example.trim().length > 10,
    f?.refusal ? f.message : `score=${f?.score} hints=${f?.hints?.length}`
  );
  const improvedLen = f?.improved_version?.length || 0;
  note(
    "Фидбек: improved_version не роман (≤900 симв.)",
    f && (f.refusal || improvedLen <= 900),
    `len=${improvedLen}`
  );
  const geLen = f?.good_example?.length || 0;
  note(
    "Фидбек: good_example ≠ improved_version (не копипаст)",
    f &&
      (f.refusal ||
        (f.good_example &&
          f.improved_version &&
          f.good_example.trim() !== f.improved_version.trim())),
    f?.refusal ? "" : `ge=${geLen}`
  );

  // 5) Слишком короткий ответ — не refusal, а низкая оценка
  f = await generateFeedback({
    ...ctx,
    userAnswer: "ок",
    dialogHistory: [],
  });
  note(
    "Фидбек: «ок» → не refusal (оценка слабого ответа)",
    f && !f.refusal && f.score <= 3,
    f?.refusal ? `unexpected refusal: ${f.message}` : `score=${f?.score}`
  );

  // 6) Чистый офтоп
  f = await generateFeedback({
    ...ctx,
    userAnswer: "Какая сегодня погода в Москве?",
    dialogHistory: [],
  });
  note(
    "Фидбек: погода → refusal",
    f && f.refusal === true,
    f?.message?.slice(0, 80)
  );

  // 7) «да» — как «ок», не refusal
  f = await generateFeedback({
    ...ctx,
    userAnswer: "да",
    dialogHistory: [],
  });
  note(
    "Фидбек: «да» → refusal:false и низкий score",
    f && !f.refusal && f.score <= 3,
    f?.refusal ? f.message : `score=${f?.score}`
  );

  // 8) Подсказки и фидбек на русском (нет длинных латинских слов в hints)
  f = await generateFeedback({
    ...ctx,
    userAnswer: "Ок, понял.",
    dialogHistory: [],
  });
  const hintsRu =
    f &&
    !f.refusal &&
    f.hints?.every(
      (h) => !/[a-zA-Z]{5,}/.test(h) || /[а-яёА-ЯЁ]/.test(h)
    );
  note(
    "Фидбек: hints без «чистого английского» (≥5 латинских подряд без кириллицы)",
    hintsRu,
    f?.hints?.join(" | ")
  );

  // 9) Сценарий: все пользовательские строки с кириллицей
  r = await generatePersonalizedScenario({
    profile: { niche: "веб-разработка лендингов", goal: "больше закрытых сделок", completed: true },
    level: "advanced",
    baseScenario,
    dialogHistory: [],
  });
  const allRu =
    r &&
    !r.refusal &&
    [r.scenario_title, r.client_message, r.trainer_goal, r.level_challenge].every(
      (s) => typeof s === "string" && /[а-яёА-ЯЁ]/.test(s)
    );
  note(
    "Сценарий: ключевые поля на русском (есть кириллица)",
    allRu,
    r?.refusal ? r.message : r?.scenario_title
  );

  console.log("\n--- Итог ---\n");
  const failed = checks.filter((c) => !c.ok);
  console.log(`Пройдено: ${checks.length - failed.length}/${checks.length}`);
  if (failed.length) {
    console.log("Провалы:");
    failed.forEach((x) => console.log(` - ${x.name}: ${x.detail}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
