require("dotenv").config();

const { ensureBusinessSchema } = require("../src/businessDataRepo");
const { pool } = require("../src/db");

const SCENARIOS = [
  {
    id: "expensive",
    title: "Клиент: Дорого",
    objectionLabel: "дорого",
    clientMessage: "Слишком дорого для меня.",
    goal: "Показать ценность и аккуратно уточнить приоритеты клиента.",
    context: {
      clientType: "Малый бизнес, владелец сам принимает решение",
      project: "Лендинг + форма заявок",
      stage: "Вы обсудили задачу и отправили смету",
      pressure: "У клиента ограниченный бюджет и страх переплатить",
    },
    levelChallenge: {
      novice: "Сфокусируйтесь на эмпатии и одном следующем шаге.",
      mid: "Удержите ценность и предложите 2 рабочих варианта.",
      advanced: "Зафиксируйте критерий решения и мягко закройте на следующий контакт.",
    },
    goodTemplates: [
      "Понимаю, что бюджет важен. Давайте я кратко покажу, что входит в стоимость и какой результат это даст по срокам и качеству.",
      "Спасибо за честный фидбек. Могу предложить поэтапный запуск: сначала базовый объем, затем расширение по мере результата.",
    ],
  },
  {
    id: "think",
    title: "Клиент: Я подумаю",
    objectionLabel: "я подумаю",
    clientMessage: "Спасибо, я подумаю и вернусь позже.",
    goal: "Не давить, но зафиксировать следующий шаг.",
    context: {
      clientType: "Маркетолог онлайн-школы",
      project: "Автоматизация воронки заявок",
      stage: "Созвон прошел позитивно, детали отправлены",
      pressure: "Клиент откладывает решение и может пропасть",
    },
    levelChallenge: {
      novice: "Не давите: дайте короткий follow-up вопрос.",
      mid: "Сформулируйте конкретный дедлайн следующего касания.",
      advanced: "Добавьте выбор из двух действий и закрепите commit клиента.",
    },
    goodTemplates: [
      "Отлично, понимаю. Чтобы вам было проще решить, могу прислать короткое сравнение двух вариантов по срокам и бюджету. Удобно?",
      "Конечно. Давайте договоримся о точке контакта: написать вам в пятницу и уточнить решение?",
    ],
  },
  {
    id: "discount",
    title: "Клиент: Просит скидку",
    objectionLabel: "скидка",
    clientMessage: "Сделаете скидку?",
    goal: "Сохранить ценность, предложить альтернативу без демпинга.",
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
    goodTemplates: [
      "Могу снизить бюджет, если уменьшим объем первого этапа. Так сохраним качество и уложимся в ваш лимит.",
      "Скидку на тот же объем не делаю, но могу предложить бонус: дополнительный созвон по запуску и рекомендации после релиза.",
    ],
  },
  {
    id: "competence",
    title: "Клиент: Сомневается в компетенциях",
    objectionLabel: "сомнение в компетенциях",
    clientMessage: "А вы точно справитесь? Какие похожие задачи уже делали?",
    goal: "Снять риск через факты, кейсы и прозрачный процесс.",
    context: {
      clientType: "Руководитель продукта",
      project: "Личный кабинет с интеграциями",
      stage: "Вы в шорт-листе из 3 исполнителей",
      pressure: "Клиент боится срыва сроков и плохого качества",
    },
    levelChallenge: {
      novice: "Дайте 1-2 факта о релевантном опыте и спокойный тон.",
      mid: "Структурируйте ответ: опыт -> процесс -> контроль качества.",
      advanced: "Снимите риск через метрики и артефакты контроля по этапам.",
    },
    goodTemplates: [
      "Да, делал похожий проект: интеграция с CRM и Telegram-уведомления. Могу показать структуру работ и контрольные точки по неделям.",
      "Чтобы вам было спокойно, фиксирую план: этапы, метрики готовности и демо после каждого блока.",
    ],
  },
  {
    id: "followup",
    title: "Клиент не отвечает после предложения",
    objectionLabel: "нет ответа",
    clientMessage: "Вы отправили предложение, но клиент молчит 3 дня.",
    goal: "Сделать вежливый follow-up с пользой, а не 'пнуть'.",
    context: {
      clientType: "Агентство недвижимости",
      project: "Интеграция CRM и чат-уведомлений",
      stage: "КП отправлено, обратной связи нет",
      pressure: "Нужно вернуть диалог без навязчивости",
    },
    levelChallenge: {
      novice: "Коротко напомните о себе и задайте один простой вопрос.",
      mid: "Добавьте полезность в follow-up, а не просто напоминание.",
      advanced: "Переформулируйте ценность и предложите бинарный выбор действия.",
    },
    goodTemplates: [
      "Напомню о предложении: если актуально, могу адаптировать этапы под ваш текущий приоритет и прислать обновленный план.",
      "На случай если письмо потерялось: коротко продублирую 2 варианта запуска и сроки. Подсказать, какой ближе к вашей задаче?",
    ],
  },
  {
    id: "cold",
    title: "Холодное обращение",
    objectionLabel: "первое сообщение",
    clientMessage: "Нужно написать первое сообщение потенциальному клиенту.",
    goal: "Кратко зацепить ценностью и предложить понятный следующий шаг.",
    context: {
      clientType: "E-commerce менеджер",
      project: "Оптимизация обработки заявок",
      stage: "Первый контакт, вас еще не знают",
      pressure: "Важно за 2-3 фразы вызвать интерес",
    },
    levelChallenge: {
      novice: "Сделайте простую структуру: кто вы, чем полезны, вопрос.",
      mid: "Добавьте мини-кейс или ориентир по результату.",
      advanced: "Сегментируйте оффер под роль клиента и предложите четкий CTA.",
    },
    goodTemplates: [
      "Здравствуйте! Увидел вашу задачу по [тема]. Могу за 5-7 дней сделать рабочий MVP с фокусом на [результат]. Если удобно, пришлю план в 5 пунктах.",
      "Привет! Помогаю командам запускать [тип задач] без затяжных сроков. Могу предложить 2 варианта реализации под ваш бюджет.",
    ],
  },
];

const EVALUATION_RULES = [
  { id: "empathy", title: "Эмпатия", description: "Есть уважительный тон и признание позиции клиента." },
  { id: "clarity", title: "Конкретика", description: "Есть понятный следующий шаг или вопрос." },
  { id: "value", title: "Ценность", description: "Объяснена польза, а не только цена/скидка." },
];

async function run() {
  await ensureBusinessSchema();
  await pool.query("BEGIN");
  try {
    await pool.query("DELETE FROM good_templates");
    await pool.query("DELETE FROM scenarios");
    await pool.query("DELETE FROM evaluation_rules");

    for (const scenario of SCENARIOS) {
      await pool.query(
        `INSERT INTO scenarios (id, title, objection_label, client_message, goal, context, level_challenge)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [
          scenario.id,
          scenario.title,
          scenario.objectionLabel,
          scenario.clientMessage,
          scenario.goal,
          JSON.stringify(scenario.context),
          JSON.stringify(scenario.levelChallenge),
        ]
      );

      for (const template of scenario.goodTemplates) {
        await pool.query(
          "INSERT INTO good_templates (scenario_id, template_text) VALUES ($1, $2)",
          [scenario.id, template]
        );
      }
    }

    for (const rule of EVALUATION_RULES) {
      await pool.query(
        "INSERT INTO evaluation_rules (id, title, description) VALUES ($1, $2, $3)",
        [rule.id, rule.title, rule.description]
      );
    }

    await pool.query("COMMIT");
    console.log("Business data seeded.");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
}

run()
  .catch((err) => {
    console.error("Failed to seed DB:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
