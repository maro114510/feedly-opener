const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const popupSource = fs.readFileSync("popup.js", "utf8");
const contentSource = fs.readFileSync("content.js", "utf8");

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

function eventSource() {
  const listeners = new Set();
  return {
    listeners,
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); }
  };
}

function loadPopup(timer = setTimeout) {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, {
        textContent: "", value: "10", checked: false, disabled: false,
        classList: { add() {}, remove() {} },
        closest() { return null; },
        addEventListener() {}
      });
      return elements.get(selector);
    },
    querySelectorAll() { return []; }
  };
  const api = {
    runtime: { lastError: null },
    storage: { sync: { get: async () => ({}), set: async () => {} } },
    tabs: {
      onUpdated: eventSource(), onRemoved: eventSource(),
      query: async () => [], create: async () => ({ id: 1 }),
      sendMessage: async () => ({ ok: true })
    },
    webNavigation: { onDOMContentLoaded: eventSource(), onErrorOccurred: eventSource() }
  };
  const context = {
    chrome: api, document, console, URL, Number, Array, Map, Set,
    Promise, Object, Boolean, String, Math, JSON, Date,
    setTimeout: timer, clearTimeout
  };
  vm.runInNewContext(`${popupSource}\n;globalThis.__test = { createTabLoadTracker, normalizeDestinationUrl, normalizeTargets };`, context);
  return { api, exported: context.__test };
}

function loadContent() {
  const api = {
    runtime: { id: "extension-id", onMessage: eventSource() },
  };
  const document = {
    contains: () => true,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const context = {
    chrome: api, window: {}, document, location: {
      href: "https://feedly.com/i/read-later", origin: "https://feedly.com",
      pathname: "/i/read-later", reload() {}
    },
    localStorage: { getItem: () => null }, fetch: async () => ({ ok: true }),
    console, URL, Number, Array, Map, Set, Promise, Object, Boolean, String,
    Math, JSON, Date, MouseEvent: class {}, HTMLElement: class {},
    getComputedStyle: () => ({ overflowY: "visible" }),
    setTimeout, clearTimeout
  };
  vm.runInNewContext(`${contentSource}\n;globalThis.__test = { parseEntryItems, toOpenableUrl, validateSettings, handleOpen, handleUnsave, setPending(value) { pendingUnsave = value; } };`, context);
  return { api, exported: context.__test };
}

test("DOMContentLoaded verifies only the tab's main frame", async () => {
  const { api, exported } = loadPopup();
  const tracker = exported.createTabLoadTracker();
  const tab = { id: 7, status: "loading" };
  const waiting = tracker.wait(tab);
  for (const listener of api.webNavigation.onDOMContentLoaded.listeners) {
    listener({ tabId: 7, frameId: 2 });
  }
  let settled = false;
  waiting.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  for (const listener of api.webNavigation.onDOMContentLoaded.listeners) {
    listener({ tabId: 7, frameId: 0 });
  }
  assertJsonEqual(await waiting, { ok: true });
  tracker.dispose();
});

test("tab tracker accepts complete status and already-complete tabs", async () => {
  const { api, exported } = loadPopup();
  const tracker = exported.createTabLoadTracker();
  const waiting = tracker.wait({ id: 8, status: "loading" });
  for (const listener of api.tabs.onUpdated.listeners) listener(8, { status: "complete" });
  assertJsonEqual(await waiting, { ok: true });
  assertJsonEqual(await tracker.wait({ id: 9, status: "complete" }), { ok: true });
  tracker.dispose();
});

test("tab tracker reports navigation errors, closure, and timeout", async () => {
  let timeoutCallback;
  const { api, exported } = loadPopup((callback) => {
    timeoutCallback = callback;
    return 1;
  });
  const tracker = exported.createTabLoadTracker();
  const error = tracker.wait({ id: 10, status: "loading" });
  for (const listener of api.webNavigation.onErrorOccurred.listeners) {
    listener({ tabId: 10, frameId: 0, error: "net::ERR_FAILED" });
  }
  assertJsonEqual(await error, { ok: false, reason: "net::ERR_FAILED" });
  const closed = tracker.wait({ id: 11, status: "loading" });
  for (const listener of api.tabs.onRemoved.listeners) listener(11);
  assertJsonEqual(await closed, { ok: false, reason: "Tab was closed before loading completed" });
  const timedOut = tracker.wait({ id: 12, status: "loading" });
  timeoutCallback();
  assertJsonEqual(await timedOut, { ok: false, reason: "Tab loading timed out" });
  tracker.dispose();
  assert.equal(api.tabs.onUpdated.listeners.size, 0);
  assert.equal(api.tabs.onRemoved.listeners.size, 0);
  assert.equal(api.webNavigation.onDOMContentLoaded.listeners.size, 0);
  assert.equal(api.webNavigation.onErrorOccurred.listeners.size, 0);
});

test("popup input helpers reject unsafe destinations and normalize targets", () => {
  const { exported } = loadPopup();
  assert.equal(exported.normalizeDestinationUrl("javascript:alert(1)"), null);
  assert.equal(exported.normalizeDestinationUrl("https://example.com/a"), "https://example.com/a");
  assertJsonEqual(exported.normalizeTargets({ targets: [
    { id: "saved", url: "https://example.com/article" },
    { id: "bad", url: "file:///tmp/article" }
  ] }), { targets: [{ id: "saved", url: "https://example.com/article" }], invalidCount: 1 });
});

test("content input helpers parse HTTP entries and normalize settings", () => {
  const { exported } = loadContent();
  assertJsonEqual(exported.parseEntryItems([
    { id: "one", alternate: [{ href: "https://example.com/one" }] },
    { id: "two", canonicalUrl: "javascript:bad" }
  ]).map(({ id, url }) => ({ id, url })), [{ id: "one", url: "https://example.com/one" }]);
  assert.equal(exported.toOpenableUrl("mailto:user@example.com"), null);
  assertJsonEqual(exported.validateSettings({ mode: "count", count: 5000, reload: false }),
    { mode: "count", count: 999, reload: false });
});

test("missing token returns the API error without creating targets", async () => {
  const { exported } = loadContent();
  const result = await exported.handleOpen({ mode: "count", count: 1, reload: false });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Please sign in to Feedly first.");
  assert.equal(result.method, "failed");
});
