require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const {
  scoreResponse,
  buildImprovedVersion,
  buildPersonalizedGoodExampleFallback,
  buildShortFeedback,
} = require("./evaluator");
const {
  STATES,
  getSession,
  resetToMainMenu,
  resetSession,
  pushDialogHistory,
} = require("./state");
const { ensureBusinessSchema, getBusinessData } = require("./businessDataRepo");
const {
  PLAN_FREE,
  PLAN_PRO,
  ensureAccessSchema,
  getOrCreateUserAccess,
  getUserAccess,
  userExists,
  setUserPlan,
} = require("./accessRepo");
const { pool } = require("./db");
const {
  isLlmEnabled,
  generatePersonalizedScenario,
  generateFeedback,
  evaluateBugReport,
} = require("./llm");

const EXPERIENCE_LEVELS = {
  novice: "Новичок",
  mid: "Средний",
  advanced: "Продвинутый",
};
const FREE_SCENARIO_IDS = new Set(["expensive", "think"]);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "@nnixaiI";
const ADMIN_IDS = new Set(
  String(process.env.ADMIN_IDS || "8031970727")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
);

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
  PLAN_STATUS: "menu:plan_status",
  LEVEL: "menu:level",
  REPORT_BUG: "menu:report_bug",
  BACK_MENU: "menu:back",
  NEW_SCENARIO: "result:new_scenario",
  RETRY: "result:retry",
  SCENARIO_PREFIX: "scenario:",
  LEVEL_PREFIX: "level:",
  PROFILE_START: "profile:start",
  PROFILE_EDIT: "profile:edit",
  PROFILE_EDIT_CONFIRM: "profile:edit:confirm",
  OPEN_PRO: "paywall:open_pro",
  OPEN_PRO_DETAILS: "paywall:details",
};

const PROFILE_STEPS = ["niche", "goal"];

const PROFILE_QUESTIONS = {
  niche: "Расскажите про вашу нишу. Например: Telegram-боты для малого бизнеса.",
  goal: "Какую цель хотите получить от тренажера в ближайший месяц?",
};

function buildGreetingText(ctx) {
  const name = ctx.from?.first_name || "друг";
  return (
    `Привет, ${name}!\n\n` +
    `Я тренажёр переговоров в переписке для фрилансеров-разработчиков: отработаем возражения клиентов и дам короткий фидбек по вашему ответу.\n\n` +
    `Команды:\n` +
    `/start — приветствие и меню\n` +
    `/reset — начать с нуля (профиль, прогресс и история)\n` +
    `/cancel — отмена и возврат в меню`
  );
}

function trimForHistory(text, maxLen = 1800) {
  const t = String(text).trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}

function isProPlan(session) {
  return session.plan === PLAN_PRO;
}

function isScenarioLockedForPlan(scenarioId, session) {
  if (isProPlan(session)) return false;
  return !FREE_SCENARIO_IDS.has(scenarioId);
}

async function syncSessionPlan(session, userId) {
  const access = await getOrCreateUserAccess(userId);
  session.plan = access.plan;
  return access.plan;
}

function proValueBullets() {
  return (
    `- все 6 сценариев с разными уровнями сложности\n` +
    `- сложные переговоры\n` +
    `- персонализированные диалоги\n` +
    `- тренировку, максимально близкую к реальным клиентам\n` +
    `- подробный анализ ваших ответов и рекомендации по улучшению`
  );
}

function buildPaywallText() {
  return (
    `Полная версия Closemate PRO 🔓\n` +
    `299 ₽ — разовая оплата, доступ ко всем сценариям.\n\n` +
    `Что входит:\n${proValueBullets()}\n\n` +
    `Для активации напишите админу: ${ADMIN_USERNAME}`
  );
}

function paywallKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Открыть PRO 🔓", CALLBACK.OPEN_PRO)],
    [Markup.button.callback("Что входит в PRO", CALLBACK.OPEN_PRO_DETAILS)],
    [Markup.button.callback("В меню", CALLBACK.BACK_MENU)],
  ]);
}

function mainMenuKeyboard(session) {
  const rows = [
    [Markup.button.callback("Выбрать сценарий", CALLBACK.TRAIN)],
    [Markup.button.callback("Мой прогресс", CALLBACK.PROGRESS)],
    [Markup.button.callback("Мой тариф", CALLBACK.PLAN_STATUS)],
    [Markup.button.callback("Настройки уровня", CALLBACK.LEVEL)],
    [Markup.button.callback("Изменить профиль", CALLBACK.PROFILE_EDIT)],
    [Markup.button.callback("Сообщить о проблеме", CALLBACK.REPORT_BUG)],
  ];
  if (!isProPlan(session)) {
    rows.splice(2, 0, [Markup.button.callback("Открыть PRO 🔓", CALLBACK.OPEN_PRO)]);
  }
  return Markup.inlineKeyboard(rows);
}

function profileStartKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Заполнить профиль (2 вопроса)", CALLBACK.PROFILE_START)],
  ]);
}

function profileEditConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Да, изменить профиль", CALLBACK.PROFILE_EDIT_CONFIRM)],
    [Markup.button.callback("Отмена", CALLBACK.BACK_MENU)],
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
      `${scenario.title}${isScenarioLockedForPlan(scenario.id, session) ? " 🔒 PRO" : ""}  ${
        getScenarioBadge(levelStats[scenario.id])
      }`,
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

/** Модель иногда копирует примеры «[тип клиента]» из промпта — подменяем на нишу или контекст каталога. */
function isAiContextPlaceholder(value) {
  if (typeof value !== "string") return true;
  const t = value.trim();
  if (!t) return true;
  if (/^\[тип\s*клиента\]$/i.test(t)) return true;
  if (/^\[услуга\]$/i.test(t)) return true;
  if (/^\[заказчик\]$/i.test(t)) return true;
  if (/^\[проект\]$/i.test(t)) return true;
  if (/^\[client\s*type\]$/i.test(t)) return true;
  if (/^\[service\]$/i.test(t)) return true;
  const m = t.match(/^\[([^\]]+)\]$/);
  if (m) {
    const inner = m[1].trim().toLowerCase();
    if (
      inner === "тип клиента" ||
      inner === "услуга" ||
      inner === "заказчик" ||
      inner === "проект" ||
      inner === "не указана" ||
      inner === "заглушка"
    )
      return true;
  }
  return false;
}

function enrichAiScenario(ai, session, catalogScenario) {
  const niche = (session.profile?.niche || "").trim();
  const ctx = catalogScenario?.context || {};
  const fallbackClient =
    typeof ctx.clientType === "string" && ctx.clientType.trim()
      ? ctx.clientType.trim()
      : "Заказчик (типовой для переписки)";
  const fallbackProject =
    typeof ctx.project === "string" && ctx.project.trim()
      ? ctx.project.trim()
      : "Проект по договорённости";

  let { client_type, project_hint } = ai.context;
  if (isAiContextPlaceholder(client_type)) {
    client_type = niche ? `Заказчик в нише: ${niche}` : fallbackClient;
  }
  if (isAiContextPlaceholder(project_hint)) {
    project_hint = niche ? `Проект в области: ${niche}` : fallbackProject;
  }
  return {
    ...ai,
    context: {
      ...ai.context,
      client_type,
      project_hint,
    },
  };
}

function formatDbScenarioIntro(session, scenario) {
  return (
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
}

function formatAiScenarioIntro(session, scenario, ai) {
  const level = session.experienceLevel || "novice";
  return (
    `Сценарий: ${ai.scenario_title}\n` +
    `(тип: ${scenario.title})\n\n` +
    `Ваш профиль:\n` +
    `- Ниша: ${session.profile.niche}\n` +
    `- Цель: ${session.profile.goal}\n\n` +
    `Контекст ситуации:\n` +
    `- Клиент: ${ai.context.client_type}\n` +
    `- Проект: ${ai.context.project_hint}\n` +
    `- Этап: ${ai.context.stage}\n` +
    `- Напряжение: ${ai.context.tension}\n\n` +
    `Челлендж уровня:\n- ${ai.level_challenge}\n\n` +
    `Сообщение клиента:\n"${ai.client_message}"\n\n` +
    `Цель: ${ai.trainer_goal}\n\n` +
    `Напишите ваш ответ одним сообщением.`
  );
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
  const levelLabel = isProPlan(session)
    ? session.experienceLevel
      ? EXPERIENCE_LEVELS[session.experienceLevel]
      : "не выбран"
    : EXPERIENCE_LEVELS.novice;
  const planLabel = isProPlan(session) ? "PRO" : "Free";
  const freeHint = isProPlan(session)
    ? ""
    : `\n\nFree-режим:\n- 2 активных сценария (остальные 🔒 PRO)\n- только уровень Новичок\n- короткий разбор ответа\n- расширенная персонализация 🔒`;
  const text =
    `Тренажер продаж для фрилансеров.\nТариф: ${planLabel}\nУровень: ${levelLabel}` +
    `${freeHint}\n\nВыберите действие:`;
  await ctx.reply(text, mainMenuKeyboard(session));
  pushDialogHistory(session, "assistant", text);
}

function getNextProfileStep(profile) {
  return PROFILE_STEPS.find((step) => !profile[step]) || null;
}

function isAdminUser(ctx) {
  return ADMIN_IDS.has(String(ctx.from?.id || ""));
}

function parseCommandArgUserId(ctx) {
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  return parts[1] ? String(parts[1]).trim() : "";
}

async function askProfileQuestion(ctx, session) {
  const nextStep = getNextProfileStep(session.profile);
  if (!nextStep) {
    session.profile.completed = true;
    session.profile.step = null;
    session.state = STATES.MAIN_MENU;
    const done =
      "Профиль заполнен. Теперь сценарии будут персонализированы под вас.";
    await ctx.reply(done);
    pushDialogHistory(session, "assistant", done);
    await showMainMenu(ctx, session);
    return;
  }

  session.profile.step = nextStep;
  session.state = STATES.PROFILE_INTAKE;
  const q = PROFILE_QUESTIONS[nextStep];
  await ctx.reply(q);
  pushDialogHistory(session, "assistant", q);
}

bot.start(async (ctx) => {
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  resetToMainMenu(userId);
  session.dialogHistory = [];

  const greet = buildGreetingText(ctx);
  await ctx.reply(greet);
  pushDialogHistory(session, "assistant", greet);

  if (isProPlan(session) && !session.profile.completed) {
    const t =
      "Для более точной персонализации в PRO можно заполнить профиль (2 вопроса) в меню «Изменить профиль».";
    await ctx.reply(t);
    pushDialogHistory(session, "assistant", t);
  }
  await showMainMenu(ctx, session);
});

bot.command("reset", async (ctx) => {
  const userId = String(ctx.from.id);
  await ctx.sendChatAction("typing");
  resetSession(userId);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  const msg =
    "Готово: профиль, прогресс и история диалога сброшены. Начинаем заново.";
  await ctx.reply(msg);
  pushDialogHistory(session, "assistant", msg);
  if (isProPlan(session)) {
    const hint =
      "Заполните профиль двумя короткими ответами — так сценарии будут персональнее.";
    await ctx.reply(hint, profileStartKeyboard());
    pushDialogHistory(session, "assistant", hint);
  } else {
    await showMainMenu(ctx, session);
  }
});

bot.command("cancel", async (ctx) => {
  const session = getSession(String(ctx.from.id));
  resetToMainMenu(String(ctx.from.id));
  const t = "Действие отменено.";
  await ctx.reply(t);
  pushDialogHistory(session, "assistant", t);
  await showMainMenu(ctx, session);
});

bot.command("grant_pro", async (ctx) => {
  if (!isAdminUser(ctx)) return;
  const targetId = parseCommandArgUserId(ctx);
  if (!targetId) {
    await ctx.reply("Использование: /grant_pro <user_id>");
    return;
  }
  if (!(await userExists(targetId))) {
    await ctx.reply(`Пользователь ${targetId} не найден. Он должен хотя бы раз открыть бота.`);
    return;
  }
  const updated = await setUserPlan({
    userId: targetId,
    plan: PLAN_PRO,
    adminId: String(ctx.from.id),
    source: "manual",
    planType: "one_time",
    isActive: true,
  });
  console.log("[ACCESS_CHANGE]", {
    by: String(ctx.from.id),
    targetId,
    plan: updated.plan,
    source: updated.source,
    at: new Date().toISOString(),
  });
  await ctx.reply(`Готово: пользователю ${targetId} выдан PRO.`);
});

bot.command("revoke_pro", async (ctx) => {
  if (!isAdminUser(ctx)) return;
  const targetId = parseCommandArgUserId(ctx);
  if (!targetId) {
    await ctx.reply("Использование: /revoke_pro <user_id>");
    return;
  }
  if (!(await userExists(targetId))) {
    await ctx.reply(`Пользователь ${targetId} не найден.`);
    return;
  }
  const updated = await setUserPlan({
    userId: targetId,
    plan: PLAN_FREE,
    adminId: String(ctx.from.id),
    source: "manual",
    planType: "one_time",
    isActive: true,
  });
  console.log("[ACCESS_CHANGE]", {
    by: String(ctx.from.id),
    targetId,
    plan: updated.plan,
    source: updated.source,
    at: new Date().toISOString(),
  });
  await ctx.reply(`Готово: пользователю ${targetId} возвращен FREE.`);
});

bot.command("plan", async (ctx) => {
  if (!isAdminUser(ctx)) return;
  const targetId = parseCommandArgUserId(ctx);
  if (!targetId) {
    await ctx.reply("Использование: /plan <user_id>");
    return;
  }
  const access = await getUserAccess(targetId);
  await ctx.reply(
    `План пользователя ${targetId}:\n` +
      `- plan: ${access.plan}\n` +
      `- type: ${access.planType}\n` +
      `- source: ${access.source}\n` +
      `- active: ${access.isActive ? "yes" : "no"}\n` +
      `- expires_at: ${access.expiresAt || "null"}`
  );
});

bot.action(CALLBACK.BACK_MENU, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  resetToMainMenu(userId);
  await showMainMenu(ctx, session);
});

bot.action(CALLBACK.TRAIN, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  const level = isProPlan(session) ? getCurrentLevel(session) : "novice";
  session.state = STATES.SCENARIO_SELECT;
  if (!isProPlan(session)) session.experienceLevel = "novice";
  const trainIntro =
    `Уровень: ${EXPERIENCE_LEVELS[level]}\nВыберите тип возражения для тренировки.\n${getWeakScenariosHint(session, level)}`;
  await ctx.reply(trainIntro, scenariosKeyboard(session, level));
  pushDialogHistory(session, "assistant", trainIntro);
});

bot.action(CALLBACK.PROFILE_START, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  if (!isProPlan(session)) {
    const t =
      `Базовая версия использует шаблонные диалоги. Расширенная персонализация профиля доступна в PRO 🔒\n` +
      `Для активации напишите админу: ${ADMIN_USERNAME}`;
    await ctx.reply(t, paywallKeyboard());
    pushDialogHistory(session, "assistant", t);
    return;
  }
  await askProfileQuestion(ctx, session);
});

bot.action(CALLBACK.PROFILE_EDIT, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  if (!isProPlan(session)) {
    const t =
      `Расширенная персонализация 🔒 доступна только в PRO.\n` +
      `В Free вы можете тренироваться на шаблонных диалогах.\n` +
      `Для активации напишите админу: ${ADMIN_USERNAME}`;
    await ctx.reply(t, paywallKeyboard());
    pushDialogHistory(session, "assistant", t);
    return;
  }
  const warn =
    "Внимание: при изменении профиля текущий прогресс прохождения будет сброшен, и тренировка начнется заново. Продолжить?";
  await ctx.reply(warn, profileEditConfirmKeyboard());
  pushDialogHistory(session, "assistant", warn);
});

bot.action(CALLBACK.PROFILE_EDIT_CONFIRM, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  if (!isProPlan(session)) {
    const t = `Эта функция доступна в PRO. Напишите админу: ${ADMIN_USERNAME}`;
    await ctx.reply(t, paywallKeyboard());
    pushDialogHistory(session, "assistant", t);
    return;
  }
  // Новая ниша/цель меняют контекст тренировки — начинаем статистику заново.
  session.selectedScenarioId = null;
  session.attemptsInScenario = 0;
  session.scenariosCompletedCount = 0;
  session.totalAttemptsCount = 0;
  session.scoreHistory = [];
  session.bestScore = 0;
  session.scenarioStats = {};
  session.scenarioStatsByLevel = {
    novice: {},
    mid: {},
    advanced: {},
  };
  session.aiScenario = null;

  session.profile.completed = false;
  session.profile.step = null;
  session.profile.niche = "";
  session.profile.goal = "";
  const editIntro =
    "Обновим профиль. Прогресс сброшен, чтобы начать тренировки заново под новый контекст. Ответьте на 2 коротких вопроса.";
  await ctx.reply(editIntro);
  pushDialogHistory(session, "assistant", editIntro);
  await askProfileQuestion(ctx, session);
});

bot.action(CALLBACK.PROGRESS, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  const progressText = buildProgressText(session);
  await ctx.reply(progressText);
  pushDialogHistory(session, "assistant", trimForHistory(progressText));
});

bot.action(CALLBACK.PLAN_STATUS, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  const isPro = isProPlan(session);
  const text = isPro
    ? `Ваш тариф: PRO 🔓\n\nДоступны все сценарии, уровни и расширенная персонализация.`
    : `Ваш тариф: Free\n\nДоступны 2 сценария и уровень "Новичок".\nPRO (299 ₽, разово) открывает все сценарии и расширенный разбор.`;
  await ctx.reply(text, isPro ? mainMenuKeyboard(session) : paywallKeyboard());
  pushDialogHistory(session, "assistant", text);
});

bot.action(CALLBACK.REPORT_BUG, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  session.state = STATES.REPORT_INPUT;
  const reportPrompt =
    "Опишите проблему одним сообщением: что делали, что ожидали и что произошло. Я передам это в лог. Для отмены — /cancel.";
  await ctx.reply(reportPrompt);
  pushDialogHistory(session, "assistant", reportPrompt);
});

bot.action(CALLBACK.OPEN_PRO, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  if (isProPlan(session)) {
    const t = "У вас уже активирован PRO 🎉";
    await ctx.reply(t);
    pushDialogHistory(session, "assistant", t);
    return;
  }
  const text = buildPaywallText();
  await ctx.reply(text, paywallKeyboard());
  pushDialogHistory(session, "assistant", text);
});

bot.action(CALLBACK.OPEN_PRO_DETAILS, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  const details =
    `Что дает PRO за 299 ₽ (разово):\n${proValueBullets()}\n\n` +
    `Для активации напишите админу: ${ADMIN_USERNAME}`;
  await ctx.reply(details, paywallKeyboard());
  pushDialogHistory(session, "assistant", details);
});

bot.action(CALLBACK.LEVEL, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  if (!isProPlan(session)) {
    const lockText =
      `В бесплатной версии доступен только уровень "${EXPERIENCE_LEVELS.novice}".\n` +
      `Остальные уровни доступны в PRO за 299 ₽.\n` +
      `Для активации напишите админу: ${ADMIN_USERNAME}`;
    await ctx.reply(lockText, paywallKeyboard());
    pushDialogHistory(session, "assistant", lockText);
    return;
  }
  session.state = STATES.LEVEL_SELECT;
  const levelPrompt = "Выберите ваш уровень опыта:";
  await ctx.reply(levelPrompt, levelKeyboard());
  pushDialogHistory(session, "assistant", levelPrompt);
});

bot.action(new RegExp(`^${CALLBACK.LEVEL_PREFIX}`), async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  if (!isProPlan(session)) {
    const t = `Этот уровень доступен в полной версии 🔓\n299 ₽ — доступ ко всем сценариям.\nДля активации: ${ADMIN_USERNAME}`;
    await ctx.reply(t, paywallKeyboard());
    pushDialogHistory(session, "assistant", t);
    return;
  }
  const level = ctx.match.input.replace(CALLBACK.LEVEL_PREFIX, "");
  if (!EXPERIENCE_LEVELS[level]) {
    const unk = "Неизвестный уровень.";
    await ctx.reply(unk);
    pushDialogHistory(session, "assistant", unk);
    return;
  }

  session.experienceLevel = level;
  session.state = STATES.MAIN_MENU;
  const savedLevel = `Уровень сохранен: ${EXPERIENCE_LEVELS[level]}.`;
  await ctx.reply(savedLevel);
  pushDialogHistory(session, "assistant", savedLevel);
  await showMainMenu(ctx, session);
});

bot.action(new RegExp(`^${CALLBACK.SCENARIO_PREFIX}`), async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  const scenarioId = ctx.match.input.replace(CALLBACK.SCENARIO_PREFIX, "");
  const scenario = getScenarioById(scenarioId);
  if (!scenario) {
    const nf = "Сценарий не найден.";
    await ctx.reply(nf);
    pushDialogHistory(session, "assistant", nf);
    return;
  }
  if (isScenarioLockedForPlan(scenario.id, session)) {
    const lock =
      `Этот сценарий доступен в полной версии 🔓\n` +
      `299 ₽ — доступ ко всем сценариям и уровням.\n` +
      `Для активации напишите админу: ${ADMIN_USERNAME}`;
    await ctx.reply(lock, paywallKeyboard());
    pushDialogHistory(session, "assistant", lock);
    return;
  }

  session.selectedScenarioId = scenario.id;
  session.attemptsInScenario = 0;
  session.state = STATES.SCENARIO_INTRO;
  session.aiScenario = null;

  const level = isProPlan(session) ? getCurrentLevel(session) : "novice";
  if (!isProPlan(session)) session.experienceLevel = "novice";
  await ctx.sendChatAction("typing");
  if (isProPlan(session) && isLlmEnabled()) {
    await ctx.reply("Подбираю персональный сценарий под ваш профиль...");
  }

  let aiPayload = null;
  if (isProPlan(session) && isLlmEnabled()) {
    try {
      aiPayload = await generatePersonalizedScenario({
        profile: session.profile,
        level,
        baseScenario: scenario,
        dialogHistory: session.dialogHistory,
      });
    } catch (err) {
      console.error("LLM scenario error:", err);
    }
  }

  if (aiPayload && aiPayload.refusal) {
    await ctx.reply(aiPayload.message);
    pushDialogHistory(session, "assistant", aiPayload.message);
    session.state = STATES.SCENARIO_SELECT;
    const pick = `Уровень: ${EXPERIENCE_LEVELS[level]}\nВыберите сценарий:`;
    await ctx.reply(pick, scenariosKeyboard(session, level));
    pushDialogHistory(session, "assistant", pick);
    return;
  }

  if (aiPayload && !aiPayload.refusal) {
    const enriched = enrichAiScenario(aiPayload, session, scenario);
    session.aiScenario = enriched;
    const intro = formatAiScenarioIntro(session, scenario, enriched);
    await ctx.reply(intro);
    pushDialogHistory(session, "assistant", trimForHistory(intro));
  } else {
    const introDb = formatDbScenarioIntro(session, scenario);
    await ctx.reply(introDb);
    pushDialogHistory(session, "assistant", trimForHistory(introDb));
  }
  session.state = STATES.USER_RESPONSE_INPUT;
});

bot.action(CALLBACK.RETRY, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  const scenario = getScenarioById(session.selectedScenarioId);
  if (!scenario) {
    const pickFirst = "Сначала выберите сценарий.";
    await ctx.reply(pickFirst);
    pushDialogHistory(session, "assistant", pickFirst);
    return;
  }
  session.state = STATES.USER_RESPONSE_INPUT;
  if (session.aiScenario) {
    const ai = session.aiScenario;
    const retryText =
      `Переигрываем "${ai.scenario_title}".\n` +
      `Контекст: ${ai.context.project_hint}, ${ai.context.stage}.\n` +
      `Сообщение клиента: "${ai.client_message}"\n\n` +
      `Введите новый вариант ответа.`;
    await ctx.reply(retryText);
    pushDialogHistory(session, "assistant", retryText);
  } else {
    const retryText =
      `Переигрываем "${scenario.title}".\n` +
      `Вспомните контекст: ${scenario.context.project}, ${scenario.context.stage}.\n` +
      `Сообщение клиента: "${scenario.clientMessage}"\n\n` +
      `Введите новый вариант ответа.`;
    await ctx.reply(retryText);
    pushDialogHistory(session, "assistant", retryText);
  }
});

bot.action(CALLBACK.NEW_SCENARIO, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const session = getSession(userId);
  await syncSessionPlan(session, userId);
  session.state = STATES.SCENARIO_SELECT;
  session.selectedScenarioId = null;
  session.attemptsInScenario = 0;
  const level = isProPlan(session) ? getCurrentLevel(session) : "novice";
  if (!isProPlan(session)) session.experienceLevel = "novice";
  const newScText = `Уровень: ${EXPERIENCE_LEVELS[level]}\nВыберите новый сценарий:`;
  await ctx.reply(newScText, scenariosKeyboard(session, level));
  pushDialogHistory(session, "assistant", newScText);
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
      pushDialogHistory(session, "user", value);
      const shortHint = "Можно чуть подробнее, хотя бы 2-3 слова.";
      await ctx.reply(shortHint);
      pushDialogHistory(session, "assistant", shortHint);
      return;
    }
    session.profile[step] = value;
    pushDialogHistory(session, "user", value);
    await askProfileQuestion(ctx, session);
    return;
  }

  if (session.state === STATES.REPORT_INPUT) {
    const reportText = ctx.message.text.trim();
    pushDialogHistory(session, "user", reportText);
    if (!reportText) return;

    if (isLlmEnabled()) await ctx.sendChatAction("typing");
    const reportCheck = await evaluateBugReport(reportText);
    if (reportCheck && reportCheck.accept === false) {
      const reject =
        reportCheck.message ||
        "Похоже, это не похоже на баг-репорт. Опишите коротко, что не сработало.";
      await ctx.reply(reject);
      pushDialogHistory(session, "assistant", reject);
      return;
    }

    console.warn("[BUG_REPORT]", {
      userId,
      username: ctx.from?.username || null,
      firstName: ctx.from?.first_name || null,
      report: reportText,
      at: new Date().toISOString(),
    });

    session.state = STATES.MAIN_MENU;
    const thanks =
      "Спасибо! Сообщение о проблеме записано. Возвращаю вас в меню.";
    await ctx.reply(thanks);
    pushDialogHistory(session, "assistant", thanks);
    await showMainMenu(ctx, session);
    return;
  }

  if (session.state !== STATES.USER_RESPONSE_INPUT) {
    const stray = ctx.message.text.trim();
    if (stray) pushDialogHistory(session, "user", stray);
    const notWaiting =
      "Сейчас не жду свободный текст. Выберите действие через кнопки.";
    await ctx.reply(notWaiting, mainMenuKeyboard(session));
    pushDialogHistory(session, "assistant", notWaiting);
    return;
  }

  const userText = ctx.message.text.trim();
  await syncSessionPlan(session, userId);

  const scenario = getScenarioById(session.selectedScenarioId);
  if (!scenario) {
    if (userText) pushDialogHistory(session, "user", userText);
    const lost = "Сценарий потерян. Выберите его заново.";
    await ctx.reply(lost);
    pushDialogHistory(session, "assistant", lost);
    session.state = STATES.SCENARIO_SELECT;
    const level = getCurrentLevel(session);
    const listHint = "Доступные сценарии:";
    await ctx.reply(listHint, scenariosKeyboard(session, level));
    pushDialogHistory(session, "assistant", listHint);
    return;
  }
  const level = isProPlan(session) ? session.experienceLevel || "novice" : "novice";
  if (!isProPlan(session)) session.experienceLevel = "novice";
  const scenarioTitle = session.aiScenario?.scenario_title || scenario.title;
  const clientMessage = session.aiScenario?.client_message || scenario.clientMessage;
  const trainerGoal = session.aiScenario?.trainer_goal || scenario.goal;

  await ctx.sendChatAction("typing");
  if (isProPlan(session) && isLlmEnabled()) {
    await ctx.reply("Анализирую ваш ответ и готовлю персональный фидбек...");
  }

  let llmFeedback = null;
  if (isProPlan(session) && isLlmEnabled()) {
    try {
      llmFeedback = await generateFeedback({
        profile: session.profile,
        level,
        scenarioTitle,
        clientMessage,
        trainerGoal,
        userAnswer: userText,
        dialogHistory: session.dialogHistory,
      });
    } catch (err) {
      console.error("LLM feedback error:", err);
    }
  }

  if (llmFeedback && llmFeedback.refusal) {
    pushDialogHistory(session, "user", userText);
    const refuseMsg = `${llmFeedback.message}\n\nПопробуйте ответить на сообщение клиента из сценария.`;
    await ctx.reply(refuseMsg);
    pushDialogHistory(session, "assistant", refuseMsg);
    return;
  }

  session.state = STATES.AI_EVALUATION;
  session.attemptsInScenario += 1;
  session.totalAttemptsCount += 1;

  const heuristic = scoreResponse(userText, level, EVALUATION_RULES);
  let scoreForStats = heuristic.score;
  let shortFeedback = buildShortFeedback(heuristic, level);
  let improvedVersion = buildImprovedVersion(
    userText,
    scenario,
    level,
    session.profile
  );
  let hintLines =
    heuristic.hints.length > 0
      ? heuristic.hints
      : ["Ответ сильный, можно тестировать на реальном диалоге."];

  if (llmFeedback && !llmFeedback.refusal) {
    scoreForStats = llmFeedback.score;
    shortFeedback = `${llmFeedback.short_feedback}\nОценка: ${llmFeedback.score}/5`;
    improvedVersion = llmFeedback.improved_version;
    hintLines =
      llmFeedback.hints.length > 0 ? llmFeedback.hints : heuristic.hints;
  }

  let templateExample = buildPersonalizedGoodExampleFallback(
    scenario,
    session.attemptsInScenario,
    session.profile
  );
  if (llmFeedback && !llmFeedback.refusal && llmFeedback.good_example) {
    templateExample = llmFeedback.good_example;
  }
  const previousScore =
    session.scoreHistory.length > 0
      ? session.scoreHistory[session.scoreHistory.length - 1]
      : null;
  const delta =
    previousScore === null ? 0 : scoreForStats - previousScore;
  const deltaText =
    previousScore === null
      ? "первая оценка"
      : delta > 0
      ? `+${delta} к прошлой попытке`
      : delta < 0
      ? `${delta} к прошлой попытке`
      : "без изменений к прошлой попытке";

  session.scoreHistory.push(scoreForStats);
  if (session.scoreHistory.length > 20) {
    session.scoreHistory = session.scoreHistory.slice(-20);
  }
  if (scoreForStats > session.bestScore) {
    session.bestScore = scoreForStats;
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
  levelStats[scenario.id].totalScore += scoreForStats;
  levelStats[scenario.id].lastScore = scoreForStats;
  if (scoreForStats > levelStats[scenario.id].bestScore) {
    levelStats[scenario.id].bestScore = scoreForStats;
  }

  session.state = STATES.RESULT_VIEW;
  session.scenariosCompletedCount += 1;

  pushDialogHistory(session, "user", userText);
  const feedbackText = isProPlan(session)
    ? `Фидбек:\n${shortFeedback}\n\n` +
      `Что улучшить:\n- ${hintLines.join("\n- ")}\n\n` +
      `Динамика:\n` +
      `- Оценка: ${scoreForStats}/5 (${renderScoreBar(scoreForStats, 5)})\n` +
      `- Изменение: ${deltaText}\n` +
      `- Тренд: ${calcTrendLabel(session.scoreHistory)}\n\n` +
      `Улучшенная версия:\n${improvedVersion}\n\n` +
      `Пример хорошего ответа:\n${templateExample}`
    : `Фидбек (Free):\nОценка: ${scoreForStats}/5\n\n` +
      `Подсказка:\n- ${(hintLines[0] || "Добавьте больше конкретики и вопрос клиенту.").trim()}\n\n` +
      `Короткий пример:\n${templateExample.split("\n")[0]}\n\n` +
      `Хотите подробный разбор и больше сценариев? Откройте PRO за 299 ₽. Напишите админу: ${ADMIN_USERNAME}`;
  await ctx.reply(feedbackText, resultKeyboard());
  pushDialogHistory(session, "assistant", trimForHistory(feedbackText));

  if (!isProPlan(session) && session.scenariosCompletedCount >= 2 && !session.freeUpsellShown) {
    session.freeUpsellShown = true;
    const upsell =
      `Если хотите больше уровней и сценариев, можно открыть полную версию PRO за 299 ₽ (разовая оплата).\n\n` +
      `Вы получите:\n${proValueBullets()}\n\n` +
      `Для активации напишите админу: ${ADMIN_USERNAME}`;
    await ctx.reply(upsell, paywallKeyboard());
    pushDialogHistory(session, "assistant", trimForHistory(upsell));
  }
});

bot.catch((err) => {
  console.error("Bot error:", err);
});

async function initAndLaunch() {
  console.log("Starting bot...");
  await ensureBusinessSchema();
  await ensureAccessSchema();
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

if (process.env.NODE_ENV !== "test") {
  initAndLaunch().catch((err) => {
    const code = err?.response?.error_code;
    if (code === 409) {
      console.error(
        "Failed to start bot: 409 Conflict — уже кто-то вызывает getUpdates с этим BOT_TOKEN.\n" +
          "Остановите второй экземпляр бота: другой терминал (npm start / npm run dev), деплой на сервере, второй ПК.\n" +
          "Если настроен webhook на этот бот — удалите webhook или не используйте polling одновременно."
      );
    } else {
      console.error("Failed to start bot:", err);
    }
    process.exit(1);
  });
}

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

if (process.env.NODE_ENV !== "test") {
  process.once("SIGINT", async () => {
    stopBotSafe("SIGINT");
    await closePoolOnce();
  });
  process.once("SIGTERM", async () => {
    stopBotSafe("SIGTERM");
    await closePoolOnce();
  });
}

function __setTestData({ scenarios = [], evaluationRules = [] } = {}) {
  SCENARIOS = scenarios;
  EVALUATION_RULES = evaluationRules;
}

module.exports = {
  bot,
  __setTestData,
  getSession,
  STATES,
};
