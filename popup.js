const api = typeof browser !== "undefined" ? browser : chrome;
const usesPromises = typeof browser !== "undefined";
const SETTINGS_KEY = "feedlyOpenerSettings";
const DEFAULT_SETTINGS = { mode: "count", count: 10, reload: true };
const MAX_ITEMS_PER_RUN = 200;

const statusEl = document.querySelector("#status");
const runButton = document.querySelector("#run");
const countInput = document.querySelector("#count");
const modeInputs = Array.from(document.querySelectorAll('input[name="mode"]'));
const loading = document.querySelector("#loading-container");
const loadingText = document.querySelector("#loading-text");
const storageArea = api.storage?.sync || api.storage.local;
let pollId = null;

function callApi(method, ...args) {
  if (usesPromises) return method(...args);
  return new Promise((resolve, reject) => method(...args, (value) => {
    const error = api.runtime?.lastError;
    if (error) reject(error); else resolve(value);
  }));
}
function clampCount(value) { return Math.min(Math.max(Number.isFinite(value) ? value : 10, 1), MAX_ITEMS_PER_RUN); }
function setStatus(text) { statusEl.textContent = text || ""; }
function showLoading(text) { loading.classList.add("active"); loadingText.textContent = text; runButton.disabled = true; }
function hideLoading() { loading.classList.remove("active"); runButton.disabled = false; }
function settingsFromForm() { return { mode: modeInputs.find((input) => input.checked)?.value || "count", count: clampCount(Number.parseInt(countInput.value, 10)), reload: true }; }
function applySettings(settings) { modeInputs.forEach((input) => { input.checked = input.value === settings.mode; }); countInput.value = settings.count; countInput.disabled = settings.mode !== "count"; }
async function loadSettings() {
  const result = await callApi(storageArea.get, SETTINGS_KEY);
  const stored = result?.[SETTINGS_KEY] || DEFAULT_SETTINGS;
  return { mode: ["all", "count"].includes(stored.mode) ? stored.mode : "count", count: clampCount(Number.parseInt(stored.count, 10)), reload: true };
}
function render(state) {
  if (!state) return;
  const summary = `Verified: ${state.verified} · Failed: ${state.failed} · Pending: ${state.pending}`;
  if (state.status === "running") { showLoading(summary); setStatus(summary); }
  else if (state.status === "completed") { hideLoading(); setStatus(`${summary}. Unsaved: ${state.unsavedCount}.`); }
  else { hideLoading(); setStatus(`${summary}. ${state.error || "Operation failed"}. Please retry.`); }
}
async function readState(opId) { return (await callApi(api.runtime.sendMessage, { type: "GET_JOB_STATE", opId }))?.state; }
function poll(opId) {
  if (pollId) clearInterval(pollId);
  pollId = setInterval(async () => {
    try { const state = await readState(opId); render(state); if (state && state.status !== "running") { clearInterval(pollId); pollId = null; } } catch (_) { /* popup may close while the job continues */ }
  }, 500);
}
async function start() {
  showLoading("Starting...");
  setStatus("");
  const settings = settingsFromForm();
  await callApi(storageArea.set, { [SETTINGS_KEY]: settings });
  const [tab] = await callApi(api.tabs.query, { active: true, currentWindow: true });
  if (!tab?.id) { hideLoading(); setStatus("No active tab found."); return; }
  const response = await callApi(api.runtime.sendMessage, { type: "START_JOB", tabId: tab.id, settings });
  if (!response?.ok) { hideLoading(); setStatus("Could not start the operation."); return; }
  render(response.state); poll(response.state.opId);
}
async function init() {
  try { applySettings(await loadSettings()); } catch (_) { applySettings(DEFAULT_SETTINGS); }
  modeInputs.forEach((input) => input.addEventListener("change", () => { countInput.disabled = input.value !== "count"; }));
  runButton.addEventListener("click", () => start().catch(() => { hideLoading(); setStatus("Failed to start the operation."); }));
  try { const state = await readState(); if (state) { render(state); if (state.status === "running") poll(state.opId); } } catch (_) { /* background unavailable */ }
}
init();
