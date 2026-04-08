require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const {
  scoreResponse,
  buildImprovedVersion,
  buildShortFeedback,
} = require("./evaluator");
const { STATES, getSession, resetToMainMenu } = require("./state");
const { ensureBusinessSchema, getBusinessData } = require("./businessDataRepo");
const { pool } = require("./db");

const EXPERIENCE_LEVELS = {
  novice: "Новичок",
  mid: "Средний",
  advanced: "Продвинутый",
};

let SCENARIOS = [];
let EVALUATION_RULES = [];
let isBotRunning = false;

const botToken = process.env.BOT_TOKEN;
if (!botToken) {
  throw new Error("BOT_TOKEN is missing. Set it in .env");
}

const bot = new Telegraf(botToken);

const CALLBACK = {
  TRAIN: "menu:train",
  PROGRESS: "menu:progress",
  LEVEL: "menu:level",
  BACK_MENU: "menu:back",
  NEW_SCENARIO: "result:new_scenario",
  RETRY: "result:retry",
  SCENARIO_PREFIX: "scenario:",
  LEVEL_PREFIX: "level:",
  PROFILE_START: "profile:start",
  PROFILE_EDIT: "profile:edit",
};

const PROFILE_STEPS = ["niche", "goal"];

const PROFILE_QUESTIONS = {
  niche: "Расскажите про вашу нишу. Например: Telegram-боты для малого бизнеса.",
  goal: "Какую цель хотите получить от тренажера в ближайший месяц?",
};

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Выбрать сценарий", CALLBACK.TRAIN)],
    [Markup.button.callback("Мой прогресс", CALLBACK.PROGRESS)],
    [Markup.button.callback("Настройки уровня", CALLBACK.LEVEL)],
    [Markup.button.callback("Изменить профиль", CALLBACK.PROFILE_EDIT)],
  ]);
}

function profileStartKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Заполнить профиль (2 вопроса)", CALLBACK.PROFILE_START)],
  ]);
}

function getScenarioBadge(stats) {
  if (!stats || stats.attempts === 0) {
    return "⚪ не пройден";
  }
  const avg = stats.totalScore / stats.attempts;
  if (avg >= 4) {
    return `🟢 ${avg.toFixed(1)}/5`;
  }
  if (avg >= 3) {
    return `🟡 ${avg.toFixed(1)}/5`;
  }
  return `🔴 ${avg.toFixed(1)}/5`;
}

function getCurrentLevel(session) {
  return session.experienceLevel || "novice";
}

function getScenarioStatsForLevel(session, level) {
  if (!session.scenarioStatsByLevel[level]) {
    session.scenarioStatsByLevel[level] = {};
  }
  return session.scenarioStatsByLevel[level];
}

function getWeakScenariosHint(session, level) {
  const levelStats = getScenarioStatsForLevel(session, level);
  const ranked = SCENARIOS.map((scenario) => {
    const stats = levelStats[scenario.id];
    const avg =
      stats && stats.attempts > 0 ? stats.totalScore / stats.attempts : Infinity;
    return { title: scenario.title, avg, attempts: stats ? stats.attempts : 0 };
  })
    .filter((item) => item.attempts > 0)
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 2);

  if (!ranked.length) {
    return `Для уровня "${EXPERIENCE_LEVELS[level]}" пока нет данных. Пройдите 1-2 сценария для персональных рекомендаций.`;
  }

  return `Рекомендуем проработать: ${ranked
    .map((item) => `${item.title} (${item.avg.toFixed(1)}/5)`)
    .join(", ")}`;
}

function scenariosKeyboard(session, level) {
  const levelStats = getScenarioStatsForLevel(session, level);
  const rows = SCENARIOS.map((scenario) => [
    Markup.button.callback(
      `${scenario.title}  ${getScenarioBadge(levelStats[scenario.id])}`,
      `${CALLBACK.SCENARIO_PREFIX}${scenario.id}`
    ),
  ]);
  rows.push([Markup.button.callback("В меню", CALLBACK.BACK_MENU)]);
  return Markup.inlineKeyboard(rows);
}

function levelKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        EXPERIENCE_LEVELS.novice,
        `${CALLBACK.LEVEL_PREFIX}novice`
      ),
      Markup.button.callback(EXPERIENCE_LEVELS.mid, `${CALLBACK.LEVEL_PREFIX}mid`),
    ],
    [
      Markup.button.callback(
        EXPERIENCE_LEVELS.advanced,
        `${CALLBACK.LEVEL_PREFIX}advanced`
      ),
    ],
    [Markup.button.callback("В меню", CALLBACK.BACK_MENU)],
  ]);
}

function resultKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Переиграть сценарий", CALLBACK.RETRY)],
    [Markup.button.callback("Новый сценарий", CALLBACK.NEW_SCENARIO)],
    [Markup.button.callback("В меню", CALLBACK.BACK_MENU)],
  ]);
}

function getScenarioById(id) {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

function renderScoreBar(score, maxScore) {
  const filled = "█".repeat(score);
  const empty = "░".repeat(Math.max(0, maxScore - score));
  return `${filled}${empty}`;
}

function calcTrendLabel(scoreHistory) {
  if (scoreHistory.length < 2) {
    return "недостаточно данных";
  }
  const prev = scoreHistory[scoreHistory.length - 2];
  const current = scoreHistory[scoreHistory.length - 1];
  if (current > prev) return "растет 📈";
  if (current < prev) return "просел 📉";
  return "стабильно ➖";
}

function getProgressStage(avgScore) {
  if (avgScore >= 4.5) return "Уверенный переговорщик";
  if (avgScore >= 3.5) return "Хорошая динамика";
  if (avgScore >= 2.5) return "Набираете форму";
  return "Старт и разогрев";
}

function buildProgressText(session) {
  const attempts = session.scoreHistory.length;
  const avgScore = attempts
    ? session.scoreHistory.reduce((sum, val) => sum + val, 0) / attempts
    : 0;
  const recent = session.scoreHistory.slice(-5);
  const recentLine = recent.length ? recent.join(" → ") : "пока нет";
  const currentScore = recent.length ? recent[recent.length - 1] : 0;
  const scoreBar = currentScore ? renderScoreBar(currentScore, 5) : "░░░░░";

  return (
    `Ваш прогресс:\n` +
    `- Пройдено сценариев: ${session.scenariosCompletedCount}\n` +
    `- Всего попыток: ${session.totalAttemptsCount}\n` +
    `- Лучшая оценка: ${session.bestScore || 0}/5\n` +
    `- Средний балл: ${avgScore.toFixed(2)}/5\n` +
    `- Последние 5 оценок: ${recentLine}\n` +
    `- Текущий тренд: ${calcTrendLabel(session.scoreHistory)}\n` +
    `- Текущий уровень: ${getProgressStage(avgScore)}\n` +
    `- Последняя попытка: ${scoreBar}`
  );
}

async function showMainMenu(ctx, session) {
  session.state = STATES.MAIN_MENU;
  const levelLabel = session.experienceLevel
    ? EXPERIENCE_LEVELS[session.experienceLevel]
    : "не выбран";
  await ctx.reply(
    `Тренажер продаж для фрилансеров.\nУровень: ${levelLabel}\n\nВыберите действие:`,
    mainMenuKeyboard()
  );
}

function getNextProfileStep(profile) {
  return PROFILE_STEPS.find((step) => !profile[step]) || null;
}

async function askProfileQuestion(ctx, session) {
  const nextStep = getNextProfileStep(session.profile);
  if (!nextStep) {
    session.profile.completed = true;
    session.profile.step = null;
    session.state = STATES.MAIN_MENU;
    await ctx.reply("Профиль заполнен. Теперь сценарии будут персонализированы под вас.");
    await showMainMenu(ctx, session);
    return;
  }

  session.profile.step = nextStep;
  session.state = STATES.PROFILE_INTAKE;
  await ctx.reply(PROFILE_QUESTIONS[nextStep]);
}

bot.start(async (ctx) => {
  const session = getSession(String(ctx.from.id));
  resetToMainMenu(String(ctx.from.id));
  if (!session.profile.completed) {
    await ctx.reply(
      "Перед первой тренировкой давайте быстро соберем профиль, чтобы сделать сценарии под вас.",
      profileStartKeyboard()
    );
    return;
  }
  await showMainMenu(ctx, session);
});

bot.command("cancel", async (ctx) => {
  const session = getSession(String(ctx.from.id));
  resetToMainMenu(String(ctx.from.id));
  await ctx.reply("Действие отменено.");
  await showMainMenu(ctx, session);
});

bot.action(CALLBACK.BACK_MENU, async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(String(ctx.from.id));
  resetToMainMenu(String(ctx.from.id));
  await showMainMenu(ctx, session);
});

bot.action(CALLBACK.TRAIN, async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(String(ctx.from.id));
  if (!session.profile.completed) {
    await ctx.reply(
      "Сначала заполните короткий профиль, чтобы сценарии были адаптированы под вашу ситуацию.",
      profileStartKeyboard()
    );
    return;
  }
  const level = getCurrentLevel(session);
  session.state = STATES.SCENARIO_SELECT;
  await ctx.reply(
    `Уровень: ${EXPERIENCE_LEVELS[level]}\nВыберите тип возражения для тренировки.\n${getWeakScenariosHint(
      session,
      level
    )}`,
    scenariosKeyboard(session, level)
  );
});

bot.action(CALLBACK.PROFILE_START, async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(String(ctx.from.id));
  await askProfileQuestion(ctx, session);
});

bot.action(CALLBACK.PROFILE_EDIT, async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(String(ctx.from.id));
  session.profile.completed = false;
  session.profile.step = null;
  session.profile.niche = "";
  session.profile.goal = "";
  await ctx.reply("Обновим профиль. Ответьте на 2 коротких вопроса.");
  await askProfileQuestion(ctx, session);
});

bot.action(CALLBACK.PROGRESS, async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(String(ctx.from.id));
  await ctx.reply(buildProgressText(session));
});

bot.action(CALLBACK.LEVEL, async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(String(ctx.from.id));
  session.state = STATES.LEVEL_SELECT;
  await ctx.reply("Выберите ваш уровень опыта:", levelKeyboard());
});

bot.action(new RegExp(`^${CALLBACK.LEVEL_PREFIX}`), async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(String(ctx.from.id));
  const level = ctx.match.input.replace(CALLBACK.LEVEL_PREFIX, "");
  if (!EXPERIENCE_LEVELS[level]) {
    await ctx.reply("Неизвестный уровень.");
    return;
  }

  session.experienceLevel = level;
  session.state = STATES.MAIN_MENU;
  await ctx.reply(`Уровень сохранен: ${EXPERIENCE_LEVELS[level]}.`);
  await showMainMenu(ctx, session);
});

bot.action(new RegExp(`^${CALLBACK.SCENARIO_PREFIX}`), async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(String(ctx.from.id));
  const scenarioId = ctx.match.input.replace(CALLBACK.SCENARIO_PREFIX, "");
  const scenario = getScenarioById(scenarioId);
  if (!scenario) {
    await ctx.reply("Сценарий не найден.");
    return;
  }

  session.selectedScenarioId = scenario.id;
  session.attemptsInScenario = 0;
  session.state = STATES.SCENARIO_INTRO;

  await ctx.reply(
    `Сценарий: ${scenario.title}\n\n` +
      `Ваш профиль:\n` +
      `- Ниша: ${session.profile.niche}\n` +
      `- Цель: ${session.profile.goal}\n\n` +
      `Контекст ситуации:\n` +
      `- Клиент: ${scenario.context.clientType}\n` +
      `- Проект: ${scenario.context.project}\n` +
      `- Этап: ${scenario.context.stage}\n` +
      `- Напряжение: ${scenario.context.pressure}\n\n` +
      `Челлендж уровня:\n- ${
        scenario.levelChallenge[session.experienceLevel || "novice"]
      }\n\n` +
      `Сообщение клиента:\n"${scenario.clientMessage}"\n\n` +
      `Цель: ${scenario.goal}\n\n` +
      `Напишите ваш ответ одним сообщением.`
  );
  session.state = STATES.USER_RESPONSE_INPUT;
});

bot.action(CALLBACK.RETRY, async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(String(ctx.from.id));
  const scenario = getScenarioById(session.selectedScenarioId);
  if (!scenario) {
    await ctx.reply("Сначала выберите сценарий.");
    return;
  }
  session.state = STATES.USER_RESPONSE_INPUT;
  await ctx.reply(
    `Переигрываем "${scenario.title}".\n` +
      `Вспомните контекст: ${scenario.context.project}, ${scenario.context.stage}.\n` +
      `Сообщение клиента: "${scenario.clientMessage}"\n\n` +
      `Введите новый вариант ответа.`
  );
});

bot.action(CALLBACK.NEW_SCENARIO, async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(String(ctx.from.id));
  session.state = STATES.SCENARIO_SELECT;
  session.selectedScenarioId = null;
  session.attemptsInScenario = 0;
  const level = getCurrentLevel(session);
  await ctx.reply(
    `Уровень: ${EXPERIENCE_LEVELS[level]}\nВыберите новый сценарий:`,
    scenariosKeyboard(session, level)
  );
});

bot.on("text", async (ctx) => {
  const userId = String(ctx.from.id);
  const session = getSession(userId);

  if (session.state === STATES.PROFILE_INTAKE) {
    const step = session.profile.step;
    const value = ctx.message.text.trim();
    if (!step) {
      await askProfileQuestion(ctx, session);
      return;
    }
    if (value.length < 2) {
      await ctx.reply("Можно чуть подробнее, хотя бы 2-3 слова.");
      return;
    }
    session.profile[step] = value;
    await askProfileQuestion(ctx, session);
    return;
  }

  if (session.state !== STATES.USER_RESPONSE_INPUT) {
    await ctx.reply(
      "Сейчас не жду свободный текст. Выберите действие через кнопки.",
      mainMenuKeyboard()
    );
    return;
  }

  const scenario = getScenarioById(session.selectedScenarioId);
  if (!scenario) {
    await ctx.reply("Сценарий потерян. Выберите его заново.");
    session.state = STATES.SCENARIO_SELECT;
    const level = getCurrentLevel(session);
    await ctx.reply("Доступные сценарии:", scenariosKeyboard(session, level));
    return;
  }

  session.state = STATES.AI_EVALUATION;
  session.attemptsInScenario += 1;
  session.totalAttemptsCount += 1;

  const userText = ctx.message.text.trim();
  const level = session.experienceLevel || "novice";
  const scoreResult = scoreResponse(userText, level, EVALUATION_RULES);
  const shortFeedback = buildShortFeedback(scoreResult, level);
  const improvedVersion = buildImprovedVersion(
    userText,
    scenario,
    level,
    session.profile
  );
  const templateExample =
    scenario.goodTemplates[session.attemptsInScenario % scenario.goodTemplates.length];
  const previousScore =
    session.scoreHistory.length > 0
      ? session.scoreHistory[session.scoreHistory.length - 1]
      : null;
  const delta =
    previousScore === null ? 0 : scoreResult.score - previousScore;
  const deltaText =
    previousScore === null
      ? "первая оценка"
      : delta > 0
      ? `+${delta} к прошлой попытке`
      : delta < 0
      ? `${delta} к прошлой попытке`
      : "без изменений к прошлой попытке";

  session.scoreHistory.push(scoreResult.score);
  if (session.scoreHistory.length > 20) {
    session.scoreHistory = session.scoreHistory.slice(-20);
  }
  if (scoreResult.score > session.bestScore) {
    session.bestScore = scoreResult.score;
  }
  const levelStats = getScenarioStatsForLevel(session, level);
  if (!levelStats[scenario.id]) {
    levelStats[scenario.id] = {
      attempts: 0,
      totalScore: 0,
      bestScore: 0,
      lastScore: 0,
    };
  }
  levelStats[scenario.id].attempts += 1;
  levelStats[scenario.id].totalScore += scoreResult.score;
  levelStats[scenario.id].lastScore = scoreResult.score;
  if (scoreResult.score > levelStats[scenario.id].bestScore) {
    levelStats[scenario.id].bestScore = scoreResult.score;
  }

  session.state = STATES.RESULT_VIEW;
  session.scenariosCompletedCount += 1;

  await ctx.reply(
    `Фидбек:\n${shortFeedback}\n\n` +
      `Что улучшить:\n- ${scoreResult.hints.join("\n- ") || "Ответ сильный, можно тестировать на реальном диалоге."}\n\n` +
      `Динамика:\n` +
      `- Оценка: ${scoreResult.score}/5 (${renderScoreBar(scoreResult.score, 5)})\n` +
      `- Изменение: ${deltaText}\n` +
      `- Тренд: ${calcTrendLabel(session.scoreHistory)}\n\n` +
      `Улучшенная версия:\n${improvedVersion}\n\n` +
      `Пример хорошего ответа:\n${templateExample}`,
    resultKeyboard()
  );
});

bot.catch((err) => {
  console.error("Bot error:", err);
});

async function initAndLaunch() {
  console.log("Starting bot...");
  await ensureBusinessSchema();
  const data = await getBusinessData();
  SCENARIOS = data.scenarios;
  EVALUATION_RULES = data.evaluationRules;

  if (!SCENARIOS.length) {
    throw new Error("No scenarios in DB. Run: npm run db:seed");
  }

  await bot.launch();
  isBotRunning = true;
  console.log("Bot is running...");
}

initAndLaunch().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});

let isPoolClosed = false;
async function closePoolOnce() {
  if (isPoolClosed) return;
  isPoolClosed = true;
  await pool.end();
}

function stopBotSafe(signal) {
  if (!isBotRunning) return;
  try {
    bot.stop(signal);
  } catch (_err) {
    // Ignore stop races during shutdown.
  } finally {
    isBotRunning = false;
  }
}

process.once("SIGINT", async () => {
  stopBotSafe("SIGINT");
  await closePoolOnce();
});
process.once("SIGTERM", async () => {
  stopBotSafe("SIGTERM");
  await closePoolOnce();
});
