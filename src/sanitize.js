/** Max length of user answer passed to LLM (characters). */
const MAX_USER_ANSWER_CHARS = 2800;

/** Max length for profile fields embedded in prompts. */
const MAX_PROFILE_FIELD_CHARS = 600;

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above)\s+instructions?/i,
  /disregard\s+(the\s+)?(system|above)/i,
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /\bsystem\s*:\s*you\s+are/i,
  /\bdeveloper\s+mode\b/i,
  /\bjailbreak\b/i,
  /раскрой\s+(системн|инструк)/i,
  /забудь\s+(все\s+)?(инструкции|правила)/i,
  /игнорируй\s+(все\s+)?(инструкции|правила|промпт)/i,
  /новая\s+роль\s*:/i,
  /выполни\s+команду\s*:/i,
];

function sanitizeText(text, maxLen) {
  if (text == null || typeof text !== "string") return "";
  let s = text.replace(/\r\n/g, "\n").replace(/\u0000/g, "");
  s = s.trim();
  if (s.length > maxLen) {
    s = `${s.slice(0, maxLen)}\n[…текст обрезан системой]`;
  }
  return s;
}

function sanitizeUserAnswerForLlm(text) {
  return sanitizeText(text, MAX_USER_ANSWER_CHARS);
}

function sanitizeProfileField(text) {
  return sanitizeText(text, MAX_PROFILE_FIELD_CHARS);
}

/**
 * Грубая эвристика: явная попытка prompt injection — можно не вызывать LLM.
 */
function looksLikePromptInjection(text) {
  if (!text || typeof text !== "string") return false;
  const sample = text.slice(0, 4000);
  return INJECTION_PATTERNS.some((re) => re.test(sample));
}

module.exports = {
  MAX_USER_ANSWER_CHARS,
  MAX_PROFILE_FIELD_CHARS,
  sanitizeUserAnswerForLlm,
  sanitizeProfileField,
  looksLikePromptInjection,
};
