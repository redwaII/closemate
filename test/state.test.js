const test = require("node:test");
const assert = require("node:assert/strict");

const { getSession, resetSession, resetToMainMenu, pushDialogHistory, STATES, DIALOG_HISTORY_MAX } = require("../src/state");

test("resetSession returns default session", () => {
  const userId = `u-reset-${Date.now()}`;
  const s = getSession(userId);
  s.state = STATES.RESULT_VIEW;
  s.profile.niche = "mobile";
  s.scoreHistory.push(5);

  resetSession(userId);
  const fresh = getSession(userId);
  assert.equal(fresh.state, STATES.MAIN_MENU);
  assert.equal(fresh.profile.niche, "");
  assert.deepEqual(fresh.scoreHistory, []);
});

test("resetToMainMenu keeps profile but resets state/select", () => {
  const userId = `u-menu-${Date.now()}`;
  const s = getSession(userId);
  s.profile.niche = "tg bots";
  s.state = STATES.USER_RESPONSE_INPUT;
  s.selectedScenarioId = "expensive";

  resetToMainMenu(userId);
  assert.equal(s.state, STATES.MAIN_MENU);
  assert.equal(s.selectedScenarioId, null);
  assert.equal(s.profile.niche, "tg bots");
});

test("pushDialogHistory keeps only last N items and trims", () => {
  const userId = `u-hist-${Date.now()}`;
  const s = getSession(userId);
  s.dialogHistory = [];

  for (let i = 0; i < DIALOG_HISTORY_MAX + 3; i++) {
    pushDialogHistory(s, i % 2 ? "assistant" : "user", `m${i}`);
  }

  assert.equal(s.dialogHistory.length, DIALOG_HISTORY_MAX);
  assert.equal(s.dialogHistory[0].content, "m3");

  const long = "x".repeat(2100);
  pushDialogHistory(s, "user", long);
  assert.equal(s.dialogHistory.at(-1).content.length, 2000);
});

test("pushDialogHistory ignores invalid role and empty content", () => {
  const userId = `u-hist2-${Date.now()}`;
  const s = getSession(userId);
  s.dialogHistory = [];
  pushDialogHistory(s, "system", "nope");
  pushDialogHistory(s, "user", "   ");
  assert.equal(s.dialogHistory.length, 0);
});

