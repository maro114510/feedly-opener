const api = typeof browser !== "undefined" ? browser : chrome;
const usesPromises = typeof browser !== "undefined";

const TAB_LOAD_TIMEOUT_MS = 30000;
const MAX_CONCURRENT_TAB_LOADS = 10;
const TAB_BATCH_SIZE = 20;
const RECENT_URL_TTL_MS = 30 * 60 * 1000;
const jobs = new Map();
let latestJobId = null;
const recentlyOpened = new Map();

function callApi(method, ...args) {
  if (usesPromises) return method(...args);
  return new Promise((resolve, reject) => method(...args, (value) => {
    const error = api.runtime && api.runtime.lastError;
    if (error) reject(error); else resolve(value);
  }));
}

function newOpId() {
  if (api.randomUUID) return api.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isExtensionMessage(sender) {
  return sender?.id === api.runtime.id;
}

function rememberUrl(url) {
  const now = Date.now();
  for (const [knownUrl, openedAt] of recentlyOpened) {
    if (now - openedAt > RECENT_URL_TTL_MS) recentlyOpened.delete(knownUrl);
  }
  if (recentlyOpened.has(url)) return false;
  recentlyOpened.set(url, now);
  return true;
}

function snapshot(job) {
  return {
    opId: job.opId,
    status: job.status,
    verified: job.verified,
    failed: job.failed,
    pending: job.pending,
    unsavedCount: job.unsavedCount,
    skippedDuplicates: job.skippedDuplicates,
    results: job.results,
    error: job.error || null
  };
}

function createTracker() {
  const outcomes = new Map();
  const waiters = new Map();
  const timers = new Set();
  const record = (tabId, result) => {
    if (outcomes.has(tabId)) return;
    outcomes.set(tabId, result);
    const waiter = waiters.get(tabId);
    if (waiter) { waiters.delete(tabId); waiter(result); }
  };
  const onUpdated = (tabId, changeInfo) => {
    if (changeInfo.status === "complete") record(tabId, { ok: true });
  };
  const onRemoved = (tabId) => record(tabId, { ok: false, reason: "Tab was closed" });
  const onDOMContentLoaded = (details) => {
    if (details.frameId === 0) record(details.tabId, { ok: true });
  };
  const onErrorOccurred = (details) => {
    if (details.frameId === 0) record(details.tabId, { ok: false, reason: details.error || "Navigation failed" });
  };
  api.tabs.onUpdated.addListener(onUpdated);
  api.tabs.onRemoved.addListener(onRemoved);
  api.webNavigation?.onDOMContentLoaded?.addListener(onDOMContentLoaded);
  api.webNavigation?.onErrorOccurred?.addListener(onErrorOccurred);
  return {
    wait(tab) {
      if (!Number.isInteger(tab?.id)) return Promise.resolve({ ok: false, reason: "No tab ID" });
      if (tab.status === "complete") record(tab.id, { ok: true });
      if (outcomes.has(tab.id)) return Promise.resolve(outcomes.get(tab.id));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { timers.delete(timer); record(tab.id, { ok: false, reason: "Tab loading timed out" }); }, TAB_LOAD_TIMEOUT_MS);
        timers.add(timer);
        waiters.set(tab.id, (result) => { clearTimeout(timer); timers.delete(timer); resolve(result); });
      });
    },
    dispose() {
      api.tabs.onUpdated.removeListener(onUpdated);
      api.tabs.onRemoved.removeListener(onRemoved);
      api.webNavigation?.onDOMContentLoaded?.removeListener(onDOMContentLoaded);
      api.webNavigation?.onErrorOccurred?.removeListener(onErrorOccurred);
      timers.forEach(clearTimeout);
    }
  };
}

async function sendToSource(tabId, message) {
  try { return await callApi(api.tabs.sendMessage, tabId, message); } catch (_) { /* inject below */ }
  try {
    await callApi(api.scripting.executeScript, { target: { tabId }, files: ["content.js"] });
    return await callApi(api.tabs.sendMessage, tabId, message);
  } catch (_) { return null; }
}

async function processJob(job, tabId, settings) {
  const tracker = createTracker();
  try {
    const response = await sendToSource(tabId, { type: "FEEDLY_OPEN", opId: job.opId, settings });
    if (!response?.ok) throw new Error(response?.error || "Could not read Feedly saved items");
    const candidates = Array.isArray(response.targets) ? response.targets : [];
    const targets = candidates.filter((target) => typeof target?.id === "string" && typeof target?.url === "string");
    job.pending = targets.length;
    if (targets.length === 0) {
      job.status = "completed";
      return;
    }
    const verifiedIds = [];
    let nextIndex = 0;
    const processBatch = async (batch) => {
      const worker = async () => {
        while (nextIndex < batch.length) {
          const target = batch[nextIndex++];
          if (!rememberUrl(target.url)) {
            job.skippedDuplicates += 1;
            job.pending -= 1;
            job.results.push({ target, ok: false, reason: "Already opened recently" });
            continue;
          }
          let result;
          try { result = await tracker.wait(await callApi(api.tabs.create, { url: target.url, active: false })); }
          catch (_) { result = { ok: false, reason: "Failed to create tab" }; }
          job.pending -= 1;
          if (result.ok) { job.verified += 1; verifiedIds.push(target.id); }
          else { job.failed += 1; }
          job.results.push({ target, ok: result.ok, reason: result.reason || null });
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_TAB_LOADS, batch.length) }, worker));
    };
    for (let offset = 0; offset < targets.length; offset += TAB_BATCH_SIZE) await processBatch(targets.slice(offset, offset + TAB_BATCH_SIZE));
    const unsave = await sendToSource(tabId, { type: "FEEDLY_UNSAVE", opId: job.opId, verifiedTargetIds: verifiedIds });
    if (!unsave?.ok) throw new Error(unsave?.error || "Failed to unsave verified items");
    job.unsavedCount = unsave.unsavedCount || 0;
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.error = error.message || "Operation failed";
  } finally {
    tracker.dispose();
  }
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isExtensionMessage(sender)) return false;
  if (message?.type === "START_JOB") {
    const opId = newOpId();
    const job = { opId, status: "running", verified: 0, failed: 0, pending: 0, unsavedCount: 0, skippedDuplicates: 0, results: [], error: null };
    jobs.set(opId, job); latestJobId = opId;
    sendResponse({ ok: true, state: snapshot(job) });
    processJob(job, message.tabId, message.settings || {}).catch(() => {});
    return false;
  }
  if (message?.type === "GET_JOB_STATE") {
    const job = jobs.get(message.opId) || jobs.get(latestJobId);
    sendResponse(job ? snapshot(job) : { ok: true, state: null });
    return false;
  }
  return false;
});
