const { OpenAI } = require("openai");
const {
  SYSTEM_SCENARIO_GENERATION,
  SYSTEM_FEEDBACK,
  SYSTEM_BUG_REPORT_FILTER,
  buildScenarioUserMessage,
  buildFeedbackUserMessage,
  buildBugReportFilterMessage,
} = require("./prompts");
const {
  sanitizeUserAnswerForLlm,
  sanitizeProfileField,
  looksLikePromptInjection,
} = require("./sanitize");

const MODEL = "gpt-4o-mini";
const TEMPERATURE = 0.3;
/** Фидбек с good_example длиннее; сценарий тоже укладывается. */
const MAX_TOKENS = 600;

/** Повтор при обрыве/перегрузке и редких 400 «не разобрали тело запроса». */
const CHAT_JSON_MAX_ATTEMPTS = 3;
const CHAT_JSON_RETRY_BASE_MS = 350;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableChatError(err) {
  const status = err?.status ?? err?.response?.status;
  if (typeof status === "number") {
    if (status >= 500 && status <= 599) return true;
    if (status === 429) return true;
    if (status === 408) return true;
    if (status === 400) {
      const msg = String(err?.message || err?.error?.message || "");
      if (/parse.*json|json body|could not parse|invalid.*request body/i.test(msg))
        return true;
    }
  }
  const msg = String(err?.message || err?.cause?.message || err || "");
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(msg))
    return true;
  return false;
}

/** Локальный отказ без вызова API (экономия и защита). */
const INJECTION_REFUSAL_MESSAGE =
  "Похоже на попытку подмены инструкций. Напишите обычный ответ клиенту по сценарию, по-русски, без скрытых команд.";

function isLlmEnabled() {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
}

function getClient() {
  if (!isLlmEnabled()) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
}

function normalizeDialogHistory(dialogHistory) {
  if (!Array.isArray(dialogHistory)) return [];
  return dialogHistory
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .slice(-10)
    .map((m) => ({
      role: m.role,
      content: m.content.trim().slice(0, 2000),
    }));
}

async function chatJson(system, user, dialogHistory = []) {
  const client = getClient();
  if (!client) return null;
  const historyMessages = normalizeDialogHistory(dialogHistory);
  const messages = [
    { role: "system", content: system },
    ...historyMessages,
    { role: "user", content: user },
  ];

  let lastErr = null;
  for (let attempt = 0; attempt < CHAT_JSON_MAX_ATTEMPTS; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        response_format: { type: "json_object" },
        messages,
      });
      const raw = completion.choices[0]?.message?.content;
      if (!raw) {
        lastErr = new Error("empty completion content");
        if (attempt < CHAT_JSON_MAX_ATTEMPTS - 1) {
          await sleep(CHAT_JSON_RETRY_BASE_MS * 2 ** attempt);
          continue;
        }
        return null;
      }
      try {
        return JSON.parse(raw);
      } catch {
        lastErr = new SyntaxError("completion JSON parse failed");
        if (attempt < CHAT_JSON_MAX_ATTEMPTS - 1) {
          await sleep(CHAT_JSON_RETRY_BASE_MS * 2 ** attempt);
          continue;
        }
        return null;
      }
    } catch (err) {
      lastErr = err;
      const retriable = isRetriableChatError(err);
      if (!retriable || attempt === CHAT_JSON_MAX_ATTEMPTS - 1) {
        console.error("OpenAI chatJson error:", err.message || err);
        return null;
      }
      const wait = CHAT_JSON_RETRY_BASE_MS * 2 ** attempt;
      console.warn(
        `OpenAI chatJson retry ${attempt + 1}/${CHAT_JSON_MAX_ATTEMPTS} after ${wait}ms:`,
        err.message || err
      );
      await sleep(wait);
    }
  }
  if (lastErr) console.error("OpenAI chatJson gave up:", lastErr.message || lastErr);
  return null;
}

function validateScenarioPayload(data) {
  if (!data || typeof data !== "object") return null;
  if (data.refusal === true && typeof data.message === "string") {
    return { refusal: true, message: data.message };
  }
  const ctx = data.context;
  if (
    typeof data.scenario_title !== "string" ||
    typeof data.client_message !== "string" ||
    typeof data.trainer_goal !== "string" ||
    typeof data.level_challenge !== "string" ||
    !ctx ||
    typeof ctx.client_type !== "string" ||
    typeof ctx.project_hint !== "string" ||
    typeof ctx.stage !== "string" ||
    typeof ctx.tension !== "string"
  ) {
    return null;
  }
  return {
    refusal: false,
    scenario_title: data.scenario_title,
    client_message: data.client_message,
    context: {
      client_type: ctx.client_type,
      project_hint: ctx.project_hint,
      stage: ctx.stage,
      tension: ctx.tension,
    },
    trainer_goal: data.trainer_goal,
    level_challenge: data.level_challenge,
  };
}

function ensureScenarioPersonalization(payload, profile) {
  if (!payload || payload.refusal) return payload;
  const niche = sanitizeProfileField(profile?.niche || "").trim();
  const goal = sanitizeProfileField(profile?.goal || "").trim();
  if (!niche && !goal) return payload;

  const out = { ...payload, context: { ...payload.context } };

  if (niche) {
    const projectHint = String(out.context.project_hint || "");
    if (!projectHint.toLowerCase().includes(niche.toLowerCase())) {
      out.context.project_hint = `${projectHint}${projectHint ? " " : ""}(ниша: ${niche})`;
    }
  }

  if (goal) {
    const trainerGoal = String(out.trainer_goal || "");
    if (!trainerGoal.toLowerCase().includes(goal.toLowerCase())) {
      out.trainer_goal = `${trainerGoal}${trainerGoal ? " " : ""}(цель месяца: ${goal})`;
    }
    const levelChallenge = String(out.level_challenge || "");
    if (!levelChallenge.toLowerCase().includes(goal.toLowerCase())) {
      out.level_challenge = `${levelChallenge}${levelChallenge ? " " : ""}(фокус: ${goal})`;
    }
  }

  return out;
}

function validateFeedbackPayload(data) {
  if (!data || typeof data !== "object") return null;
  if (data.refusal === true && typeof data.message === "string") {
    return { refusal: true, message: data.message };
  }
  const score = Number(data.score);
  if (
    !Number.isInteger(score) ||
    score < 1 ||
    score > 5 ||
    typeof data.short_feedback !== "string" ||
    typeof data.improved_version !== "string" ||
    typeof data.good_example !== "string" ||
    !data.good_example.trim() ||
    !Array.isArray(data.hints)
  ) {
    return null;
  }
  const hints = data.hints.filter((h) => typeof h === "string").slice(0, 5);
  return {
    refusal: false,
    score,
    short_feedback: data.short_feedback,
    improved_version: data.improved_version,
    good_example: data.good_example.trim(),
    hints,
  };
}

async function generatePersonalizedScenario({
  profile,
  level,
  baseScenario,
  dialogHistory = [],
}) {
  const user = buildScenarioUserMessage({
    niche: sanitizeProfileField(profile.niche || ""),
    goal: sanitizeProfileField(profile.goal || ""),
    level,
    baseScenario,
  });
  const raw = await chatJson(SYSTEM_SCENARIO_GENERATION, user, dialogHistory);
  const validated = validateScenarioPayload(raw);
  return ensureScenarioPersonalization(validated, profile);
}

async function generateFeedback({
  profile,
  level,
  scenarioTitle,
  clientMessage,
  trainerGoal,
  userAnswer,
  dialogHistory = [],
}) {
  const safeAnswer = sanitizeUserAnswerForLlm(userAnswer || "");
  if (looksLikePromptInjection(safeAnswer)) {
    return { refusal: true, message: INJECTION_REFUSAL_MESSAGE };
  }

  const user = buildFeedbackUserMessage({
    niche: sanitizeProfileField(profile.niche || ""),
    goal: sanitizeProfileField(profile.goal || ""),
    level,
    scenarioTitle,
    clientMessage,
    trainerGoal,
    userAnswer: safeAnswer,
  });
  const raw = await chatJson(SYSTEM_FEEDBACK, user, dialogHistory);
  return validateFeedbackPayload(raw);
}

function validateBugReportFilterPayload(data) {
  if (!data || typeof data !== "object") return null;
  if (data.accept === true) return { accept: true };
  if (data.accept === false) {
    const message =
      typeof data.message === "string" && data.message.trim()
        ? data.message.trim()
        : "Похоже, в сообщении не удалось выделить проблему. Опишите баг чуть конкретнее.";
    return { accept: false, message };
  }
  return null;
}

function evaluateBugReportHeuristic(reportText) {
  const text = String(reportText || "").trim();
  if (!text) {
    return {
      accept: false,
      message: "Пустое сообщение не похоже на баг-репорт. Напишите коротко, что не сработало.",
    };
  }

  const normalized = text.toLowerCase();
  const lettersOnly = normalized.replace(/[^a-zа-яё]/gi, "");
  const words = normalized.split(/\s+/).filter(Boolean);

  // Явный мусор: одна буква/повторы/практически нет букв.
  if (lettersOnly.length <= 1) {
    return {
      accept: false,
      message: "Похоже на случайный ввод. Напишите коротко, какая ошибка произошла.",
    };
  }
  if (/^(.)\1{4,}$/i.test(lettersOnly)) {
    return {
      accept: false,
      message: "Похоже на случайный ввод. Напишите коротко, какая ошибка произошла.",
    };
  }
  if (words.length <= 2 && !/[а-яёa-z]{3,}/i.test(normalized)) {
    return {
      accept: false,
      message: "Не удалось выделить проблему. Опишите баг в 1-2 коротких фразах.",
    };
  }

  // Короткие осмысленные репорты разрешаем.
  const bugHints = [
    "не работает",
    "ошибка",
    "баг",
    "завис",
    "зависает",
    "пустой",
    "не отвечает",
    "сломалось",
    "не приходит",
    "не открывается",
    "не нажимается",
    "кнопка",
    "сценар",
    "фидбек",
    "start",
    "reset",
  ];
  if (bugHints.some((h) => normalized.includes(h))) {
    return { accept: true };
  }

  // Эмодзи/символы без явного смысла и без маркеров бага — отклоняем.
  const hasLetters = /[a-zа-яё]/i.test(normalized);
  if (!hasLetters) {
    return {
      accept: false,
      message: "Похоже, это не описание проблемы. Напишите, что именно не сработало.",
    };
  }

  // По умолчанию пропускаем: лучше принять сомнительный репорт, чем потерять полезный.
  return { accept: true };
}

async function evaluateBugReport(reportText) {
  const safeText = sanitizeUserAnswerForLlm(reportText || "");
  if (!safeText.trim()) return evaluateBugReportHeuristic(safeText);
  if (!isLlmEnabled()) return evaluateBugReportHeuristic(safeText);

  const user = buildBugReportFilterMessage(safeText);
  const raw = await chatJson(SYSTEM_BUG_REPORT_FILTER, user, []);
  const validated = validateBugReportFilterPayload(raw);
  if (validated) return validated;
  return evaluateBugReportHeuristic(safeText);
}

module.exports = {
  isLlmEnabled,
  generatePersonalizedScenario,
  generateFeedback,
  evaluateBugReport,
  normalizeDialogHistory,
  MODEL,
  INJECTION_REFUSAL_MESSAGE,
};
