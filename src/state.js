const STATES = {
  MAIN_MENU: "MAIN_MENU",
  PROFILE_INTAKE: "PROFILE_INTAKE",
  REPORT_INPUT: "REPORT_INPUT",
  SCENARIO_SELECT: "SCENARIO_SELECT",
  SCENARIO_INTRO: "SCENARIO_INTRO",
  USER_RESPONSE_INPUT: "USER_RESPONSE_INPUT",
  AI_EVALUATION: "AI_EVALUATION",
  RESULT_VIEW: "RESULT_VIEW",
  LEVEL_SELECT: "LEVEL_SELECT",
};

const sessions = new Map();

function getDefaultSession() {
  return {
    state: STATES.MAIN_MENU,
    plan: "free",
    selectedScenarioId: null,
    experienceLevel: null,
    attemptsInScenario: 0,
    scenariosCompletedCount: 0,
    totalAttemptsCount: 0,
    scoreHistory: [],
    bestScore: 0,
    scenarioStats: {},
    scenarioStatsByLevel: {
      novice: {},
      mid: {},
      advanced: {},
    },
    freeUpsellShown: false,
    profile: {
      completed: false,
      step: null,
      niche: "",
      services: "",
      experienceText: "",
      avgCheck: "",
      goal: "",
    },
    aiScenario: null,
    /** @type {{ role: 'user'|'assistant', content: string }[]} */
    dialogHistory: [],
  };
}

const DIALOG_HISTORY_MAX = 10;
const DIALOG_MSG_MAX_LEN = 2000;

function ensureDialogHistory(session) {
  if (!Array.isArray(session.dialogHistory)) {
    session.dialogHistory = [];
  }
}

function pushDialogHistory(session, role, content) {
  if (role !== "user" && role !== "assistant") return;
  ensureDialogHistory(session);
  const text = String(content ?? "")
    .trim()
    .slice(0, DIALOG_MSG_MAX_LEN);
  if (!text) return;
  session.dialogHistory.push({ role, content: text });
  if (session.dialogHistory.length > DIALOG_HISTORY_MAX) {
    session.dialogHistory = session.dialogHistory.slice(-DIALOG_HISTORY_MAX);
  }
}

function resetSession(userId) {
  sessions.set(userId, getDefaultSession());
}

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, getDefaultSession());
  }
  return sessions.get(userId);
}

function resetToMainMenu(userId) {
  const session = getSession(userId);
  session.state = STATES.MAIN_MENU;
  session.selectedScenarioId = null;
}

module.exports = {
  STATES,
  getSession,
  resetToMainMenu,
  resetSession,
  pushDialogHistory,
  DIALOG_HISTORY_MAX,
};
