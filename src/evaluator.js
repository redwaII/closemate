function splitSentences(text) {
  return text
    .split(/[.!?]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasQuestion(text) {
  return text.includes("?");
}

function hasEmpathy(text) {
  const low = text.toLowerCase();
  return [
    "понима",
    "спасибо",
    "соглас",
    "важно",
    "ценю",
    "конечно",
  ].some((token) => low.includes(token));
}

function hasValue(text) {
  const low = text.toLowerCase();
  return [
    "результат",
    "польз",
    "качество",
    "срок",
    "этап",
    "план",
    "вариант",
  ].some((token) => low.includes(token));
}

function scoreResponse(userText, level = "novice", evaluationRules = []) {
  let score = 1;
  const hints = [];
  const sentences = splitSentences(userText);
  const minLength = level === "advanced" ? 120 : level === "mid" ? 90 : 70;

  if (userText.length >= minLength) {
    score += 1;
  } else {
    if (level === "novice") {
      hints.push("Добавьте больше конкретики: минимум 2 предложения по простой схеме.");
    } else {
      hints.push(
        `Добавьте больше конкретики: целевой объем ответа около ${minLength}+ символов.`
      );
    }
  }

  if (hasEmpathy(userText)) {
    score += 1;
  } else {
    hints.push("Начните с признания позиции клиента (эмпатия).");
  }

  if (hasQuestion(userText)) {
    score += 1;
  } else {
    hints.push("Добавьте вопрос, который двигает диалог к следующему шагу.");
  }

  if (hasValue(userText)) {
    score += 1;
  } else {
    hints.push("Подсветите ценность: результат, сроки, этапность, снижение риска.");
  }

  if (level === "advanced") {
    if (sentences.length >= 3) {
      score += 1;
    } else {
      hints.push("Для продвинутого уровня: дайте структуру из 3 шагов (позиция -> ценность -> CTA).");
    }
  } else if (sentences.length < 2) {
    hints.push("Сделайте структуру: 1) реакция 2) следующий шаг.");
  }

  if (score > 5) {
    score = 5;
  }

  return {
    score,
    maxScore: 5,
    hints,
    appliedRules: evaluationRules.map((rule) => rule.title),
  };
}

function buildImprovedVersion(userText, scenario, level, profile = null) {
  let prefix = "Спасибо за уточнение, это разумный вопрос.";
  if (level === "novice") {
    prefix = "Понимаю ваш вопрос, это правда важно.";
  } else if (level === "advanced") {
    prefix = "Отличный вопрос, предлагаю быстро сверить критерии решения.";
  }
  const scenarioHint = scenario ? `По задаче "${scenario.title}"` : "По вашей задаче";
  const profileHint =
    profile && profile.niche && profile.goal
      ? `С учетом вашей ниши (${profile.niche}) и цели (${profile.goal}),`
      : "";

  if (level === "advanced") {
    return [
      prefix,
      profileHint,
      `${scenarioHint} предлагаю сверить критерии выбора: срок запуска, риск и ожидаемый результат.`,
      "Я могу дать два сценария реализации с прозрачными trade-off по бюджету и скорости.",
      "Фиксируем 15-минутный слот сегодня/завтра, чтобы выбрать вариант и стартовать?",
    ].join(" ");
  }

  if (level === "mid") {
    return [
      prefix,
      profileHint,
      `${scenarioHint} зафиксирую ценность и следующий шаг, чтобы вам было проще принять решение.`,
      "Могу предложить 2 варианта по бюджету и срокам, чтобы выбрать комфортный формат.",
      "Если удобно, пришлю структуру работ и начнем с минимального этапа уже на этой неделе?",
    ].join(" ");
  }

  return [
    prefix,
    profileHint,
    `${scenarioHint} коротко: понимаю ваш запрос и предлагаю спокойный следующий шаг.`,
    "Давайте начнем с небольшого этапа, чтобы вы увидели результат без лишнего риска.",
    "Удобно, если я пришлю простой план из 3 пунктов?",
  ].join(" ");
}

function buildShortFeedback(scoreResult, level) {
  let style = "Неплохой деловой ответ.";
  if (level === "novice") {
    style = "Вы на верном пути.";
  } else if (level === "advanced") {
    style = "Сильный уровень, виден контроль диалога.";
  }
  const fallbackTip =
    level === "novice"
      ? "Держите простую структуру: эмпатия -> польза -> вопрос."
      : level === "advanced"
      ? "Добавьте управляемый CTA и критерий решения клиента."
      : "Сохраните темп и добавьте персонализацию под клиента.";
  const tip = scoreResult.hints[0] || fallbackTip;
  return `${style} Оценка: ${scoreResult.score}/${scoreResult.maxScore}. ${tip}`;
}

module.exports = {
  scoreResponse,
  buildImprovedVersion,
  buildShortFeedback,
};
