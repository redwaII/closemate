const test = require("node:test");
const assert = require("node:assert/strict");
const { Telegram } = require("telegraf");

process.env.NODE_ENV = "test";
process.env.BOT_TOKEN = process.env.BOT_TOKEN || "123456:TEST_TOKEN";

const { bot, __setTestData, getSession, STATES } = require("../src/index");
const sentMessages = [];

function makeMessageUpdate({ updateId, userId, text }) {
  const isCommand = typeof text === "string" && text.startsWith("/");
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      text,
      entities: isCommand
        ? [{ offset: 0, length: text.length, type: "bot_command" }]
        : undefined,
      chat: { id: userId, type: "private" },
      from: { id: userId, is_bot: false, first_name: "Test" },
    },
  };
}

function makeCallbackUpdate({ updateId, userId, data }) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      data,
      from: { id: userId, is_bot: false, first_name: "Test" },
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: "private" },
        text: "btn",
      },
    },
  };
}

function installTelegramMock() {
  bot.botInfo = { id: 1, is_bot: true, username: "closemate_test", first_name: "closemate" };
  sentMessages.length = 0;
  Telegram.prototype.callApi = async (method, payload) => {
    if (method === "sendMessage") {
      sentMessages.push({ method, text: payload.text, chat_id: payload.chat_id });
      return { message_id: Date.now() };
    }
    if (method === "answerCallbackQuery") return true;
    if (method === "sendChatAction") return true;
    return true;
  };
}

const scenarios = [
  {
    id: "discount",
    title: "Клиент: Просит скидку",
    objectionLabel: "скидка",
    clientMessage: "Сделаете скидку?",
    goal: "Сохранить ценность и предложить альтернативу без демпинга.",
    context: {
      clientType: "Стартап на ранней стадии",
      project: "MVP Telegram-бота для лидов",
      stage: "Клиент согласен работать, но хочет дешевле",
      pressure: "Есть риск уйти в нерентабельный проект",
    },
    levelChallenge: {
      novice: "Не оправдывайтесь за цену, объясните пользу.",
      mid: "Предложите компромисс через объем/этапы.",
      advanced: "Сохраните маржу и переведите разговор в плоскость ROI.",
    },
    goodTemplates: ["Могу снизить бюджет, если уменьшим объем первого этапа."],
  },
];

test("bot integration: core buttons and states", async (t) => {
  __setTestData({ scenarios, evaluationRules: [{ id: "r1", title: "Rule", description: "d" }] });
  installTelegramMock();
  let updateId = 1000;

  await t.test("start -> asks for profile", async () => {
    const userId = 11001;
    await bot.handleUpdate(makeMessageUpdate({ updateId: ++updateId, userId, text: "/start" }));
    const texts = sentMessages.filter((m) => m.chat_id === userId).map((m) => m.text);
    assert.ok(texts.some((x) => /Привет/i.test(x)));
    assert.ok(texts.some((x) => /соберем профиль/i.test(x)));
  });

  await t.test("profile flow completion", async () => {
    const userId = 11002;
    await bot.handleUpdate(makeMessageUpdate({ updateId: ++updateId, userId, text: "/start" }));
    await bot.handleUpdate(
      makeCallbackUpdate({ updateId: ++updateId, userId, data: "profile:start" })
    );
    await bot.handleUpdate(
      makeMessageUpdate({ updateId: ++updateId, userId, text: "мобильная разработка" })
    );
    await bot.handleUpdate(
      makeMessageUpdate({ updateId: ++updateId, userId, text: "увеличить чек" })
    );

    const texts = sentMessages.filter((m) => m.chat_id === userId).map((m) => m.text);
    assert.ok(texts.some((x) => /Профиль заполнен/i.test(x)));
    const s = getSession(String(userId));
    assert.equal(s.profile.completed, true);
    assert.equal(s.state, STATES.MAIN_MENU);
  });

  await t.test("level selection affects train flow", async () => {
    const userId = 11003;
    const s = getSession(String(userId));
    s.profile.completed = true;
    s.profile.niche = "telegram-боты";
    s.profile.goal = "меньше скидок";

    await bot.handleUpdate(
      makeCallbackUpdate({ updateId: ++updateId, userId, data: "menu:level" })
    );
    await bot.handleUpdate(
      makeCallbackUpdate({ updateId: ++updateId, userId, data: "level:advanced" })
    );
    await bot.handleUpdate(
      makeCallbackUpdate({ updateId: ++updateId, userId, data: "menu:train" })
    );

    const texts = sentMessages.filter((m) => m.chat_id === userId).map((m) => m.text);
    assert.ok(texts.some((x) => /Уровень сохранен: Продвинутый/i.test(x)));
    assert.ok(texts.some((x) => /Уровень: Продвинутый/i.test(x)));
  });

  await t.test("profile edit confirmation resets progress", async () => {
    const userId = 11004;
    const s = getSession(String(userId));
    s.profile.completed = true;
    s.profile.niche = "old";
    s.profile.goal = "old";
    s.scoreHistory = [4, 5];
    s.bestScore = 5;
    s.scenariosCompletedCount = 2;
    s.totalAttemptsCount = 3;

    await bot.handleUpdate(
      makeCallbackUpdate({ updateId: ++updateId, userId, data: "profile:edit" })
    );
    await bot.handleUpdate(
      makeCallbackUpdate({ updateId: ++updateId, userId, data: "profile:edit:confirm" })
    );

    const texts = sentMessages.filter((m) => m.chat_id === userId).map((m) => m.text);
    assert.ok(texts.some((x) => /Внимание: при изменении профиля/i.test(x)));
    assert.ok(texts.some((x) => /Прогресс сброшен/i.test(x)));

    const fresh = getSession(String(userId));
    assert.equal(fresh.scenariosCompletedCount, 0);
    assert.equal(fresh.totalAttemptsCount, 0);
    assert.deepEqual(fresh.scoreHistory, []);
    assert.equal(fresh.bestScore, 0);
    assert.equal(fresh.state, STATES.PROFILE_INTAKE);
  });

  await t.test("report bug flow accepts meaningful short report", async () => {
    const userId = 11005;
    const s = getSession(String(userId));
    s.profile.completed = true;

    await bot.handleUpdate(
      makeCallbackUpdate({ updateId: ++updateId, userId, data: "menu:report_bug" })
    );
    await bot.handleUpdate(
      makeMessageUpdate({ updateId: ++updateId, userId, text: "не работает сценарий" })
    );

    const texts = sentMessages.filter((m) => m.chat_id === userId).map((m) => m.text);
    assert.ok(texts.some((x) => /Опишите проблему/i.test(x)));
    assert.ok(texts.some((x) => /Спасибо! Сообщение о проблеме записано/i.test(x)));
    assert.equal(getSession(String(userId)).state, STATES.MAIN_MENU);
  });

  await t.test("/reset fully resets profile, progress and history", async () => {
    const userId = 11006;
    const s = getSession(String(userId));
    s.profile.completed = true;
    s.profile.niche = "legacy niche";
    s.profile.goal = "legacy goal";
    s.scoreHistory = [2, 4, 5];
    s.bestScore = 5;
    s.scenariosCompletedCount = 3;
    s.totalAttemptsCount = 7;
    s.experienceLevel = "advanced";
    s.dialogHistory = [{ role: "user", content: "old message" }];

    await bot.handleUpdate(makeMessageUpdate({ updateId: ++updateId, userId, text: "/reset" }));

    const texts = sentMessages.filter((m) => m.chat_id === userId).map((m) => m.text);
    assert.ok(texts.some((x) => /сброшены\. Начинаем заново/i.test(x)));
    assert.ok(texts.some((x) => /Заполните профиль двумя короткими ответами/i.test(x)));

    const fresh = getSession(String(userId));
    assert.equal(fresh.profile.completed, false);
    assert.equal(fresh.profile.niche, "");
    assert.equal(fresh.profile.goal, "");
    assert.equal(fresh.bestScore, 0);
    assert.equal(fresh.scenariosCompletedCount, 0);
    assert.equal(fresh.totalAttemptsCount, 0);
    assert.equal(fresh.experienceLevel, null);
    assert.deepEqual(fresh.scoreHistory, []);
    assert.ok(fresh.dialogHistory.length >= 1);
  });

  await t.test("profile edit cancel keeps progress unchanged", async () => {
    const userId = 11007;
    const s = getSession(String(userId));
    s.profile.completed = true;
    s.profile.niche = "backend";
    s.profile.goal = "больше закрытий";
    s.scoreHistory = [3, 4];
    s.bestScore = 4;
    s.scenariosCompletedCount = 2;
    s.totalAttemptsCount = 4;

    await bot.handleUpdate(
      makeCallbackUpdate({ updateId: ++updateId, userId, data: "profile:edit" })
    );
    await bot.handleUpdate(
      makeCallbackUpdate({ updateId: ++updateId, userId, data: "menu:back" })
    );

    const texts = sentMessages.filter((m) => m.chat_id === userId).map((m) => m.text);
    assert.ok(texts.some((x) => /Внимание: при изменении профиля/i.test(x)));
    assert.ok(texts.some((x) => /Выберите действие/i.test(x)));

    const after = getSession(String(userId));
    assert.equal(after.profile.niche, "backend");
    assert.equal(after.profile.goal, "больше закрытий");
    assert.deepEqual(after.scoreHistory, [3, 4]);
    assert.equal(after.bestScore, 4);
    assert.equal(after.scenariosCompletedCount, 2);
    assert.equal(after.totalAttemptsCount, 4);
    assert.equal(after.state, STATES.MAIN_MENU);
  });
});

