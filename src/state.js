const STATES = {
  MAIN_MENU: "MAIN_MENU",
  PROFILE_INTAKE: "PROFILE_INTAKE",
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
    profile: {
      completed: false,
      step: null,
      niche: "",
      services: "",
      experienceText: "",
      avgCheck: "",
      goal: "",
    },
  };
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
};
