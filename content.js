const api = typeof browser !== "undefined" ? browser : chrome;
const usesPromises = typeof browser !== "undefined";

// =============================================================================
// Constants
// =============================================================================

// Feedly Read Later pages can vary by user id and legacy paths.
const READ_LATER_PATTERNS = [
  /https:\/\/feedly\.com\/i\/board\/content\/user\/[^/]+\/tag\/global\.saved/i,
  /https:\/\/feedly\.com\/i\/read-later/i
];
const READ_LATER_PATH_HINTS = ["/i/read-later", "/i/board/content/user/"];
const READ_LATER_CACHE_MS = 3000;
let lastReadLaterSeenAt = 0;
let lastReadLaterUrl = "";

// Entries are rendered as article cards with multiple fallbacks.
const ENTRY_SELECTORS = ["[data-entry-id]", "article", ".entry", ".entryRow"];

// SVG path data observed for saved/unsaved bookmark icons.
const BOOKMARK_ICON_SELECTED_PATH = "M13.077 2.5H6.923";
const BOOKMARK_ICON_UNSELECTED_PATH = "M13 2.357H7";
const TOOLBAR_BUTTON_SELECTOR = "button.EntryToolbar__button";
const READ_LATER_SELECTORS = [
  ".EntryMetadataReadLater a[role='button']",
  ".EntryMetadataReadLater button",
  "a[role='button'] .InterestingMetadata__icon"
];
const READ_LATER_LABELS = ["read later", "後で読む", "あとで読む"];

// =============================================================================
// Utility Functions
// =============================================================================

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReadLaterPage(url) {
  const candidateUrl = url || location.href;
  if (READ_LATER_PATTERNS.some((pattern) => pattern.test(candidateUrl))) {
    markReadLaterSeen(candidateUrl);
    return true;
  }

  const path = location.pathname || "";
  if (READ_LATER_PATH_HINTS.some((hint) => path.includes(hint))) {
    const matches = path.includes("global.saved");
    if (matches) {
      markReadLaterSeen(candidateUrl);
    }
    return matches;
  }

  if (hasReadLaterDom()) {
    markReadLaterSeen(candidateUrl);
    return true;
  }

  return isRecentlyReadLater();
}

function getEntryElements() {
  const selector = ENTRY_SELECTORS.join(",");
  const candidates = Array.from(document.querySelectorAll(selector));
  return candidates.filter((element) => getEntryLink(element));
}

function getEntryLink(entry) {
  const anchors = Array.from(entry.querySelectorAll("a[href]"));
  for (const anchor of anchors) {
    const url = toOpenableUrl(anchor.getAttribute("href"));
    if (url) {
      return url;
    }
  }
  return null;
}

function toOpenableUrl(href) {
  if (!href) {
    return null;
  }

  let url;
  try {
    url = new URL(href, location.href);
  } catch (error) {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return null;
  }

  if (url.origin === location.origin) {
    if (!url.pathname.startsWith("/i/entry/")) {
      return null;
    }
  }

  return url.toString();
}

// =============================================================================
// Save State Detection
// =============================================================================

function hasAccentClass(element) {
  const classAttr = element.getAttribute("class") || "";
  if (classAttr.includes("color--accent")) {
    return true;
  }
  if (element.classList) {
    for (const className of element.classList) {
      if (className.startsWith("color--accent")) {
        return true;
      }
    }
  }
  return false;
}

function hasSecondaryClass(element) {
  const classAttr = element.getAttribute("class") || "";
  if (classAttr.includes("color--secondary")) {
    return true;
  }
  if (element.classList) {
    for (const className of element.classList) {
      if (className.startsWith("color--secondary")) {
        return true;
      }
    }
  }
  return false;
}

function isSavedButton(button) {
  const svg = button.querySelector("svg");
  if (svg && hasSecondaryClass(svg)) {
    return false;
  }
  if (svg && hasAccentClass(svg)) {
    return true;
  }
  if (hasAccentClass(button)) {
    return true;
  }

  const icon = button.querySelector("svg path[d]");
  if (!icon) {
    return false;
  }

  const d = icon.getAttribute("d") || "";
  if (d.startsWith(BOOKMARK_ICON_UNSELECTED_PATH)) {
    return false;
  }

  return d.startsWith(BOOKMARK_ICON_SELECTED_PATH);
}

function containsReadLaterText(element) {
  const text = (element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  return READ_LATER_LABELS.some((label) => text.includes(label));
}

/**
 * Quick pre-check if entry appears to be saved (before DOM operations).
 * Returns true if saved, false if not saved, null if cannot determine.
 */
function quickCheckSaved(entry) {
  const toolbarButton = entry.querySelector(TOOLBAR_BUTTON_SELECTOR);
  if (toolbarButton) {
    const svg = toolbarButton.querySelector("svg");
    if (hasSecondaryClass(toolbarButton) || (svg && hasSecondaryClass(svg))) {
      return false;
    }
    if (hasAccentClass(toolbarButton) || (svg && hasAccentClass(svg))) {
      return true;
    }
  }

  const metaButton = entry.querySelector(READ_LATER_SELECTORS.join(","));
  if (metaButton) {
    const btn = metaButton.closest("a,button") || metaButton;
    const svg = btn.querySelector("svg");
    if (hasSecondaryClass(btn) || (svg && hasSecondaryClass(svg))) {
      return false;
    }
    if (hasAccentClass(btn) || (svg && hasAccentClass(svg))) {
      return true;
    }
  }

  return null;
}

// =============================================================================
// Button Detection
// =============================================================================

function findUnsaveButton(entry) {
  const toolbarButtons = entry.querySelectorAll(TOOLBAR_BUTTON_SELECTOR);
  for (const button of toolbarButtons) {
    if (isSavedButton(button)) {
      return button;
    }
  }

  const explicit = entry.querySelector(READ_LATER_SELECTORS.join(","));
  if (explicit) {
    const button = explicit.closest("a,button") || explicit;
    return isSavedButton(button) ? button : null;
  }

  const candidates = entry.querySelectorAll("a[role='button'], button");
  for (const candidate of candidates) {
    if (!containsReadLaterText(candidate)) {
      continue;
    }
    if (isSavedButton(candidate)) {
      return candidate;
    }
  }

  return null;
}

// =============================================================================
// Entry Processing
// =============================================================================

async function getSavedEntriesWithUrls(settings) {
  const entries = getEntryElements();
  const seen = new Set();
  const results = [];
  const limit =
    settings.mode === "count" ? Math.max(settings.count || 1, 1) : Infinity;

  for (const entry of entries) {
    if (results.length >= limit) {
      break;
    }
    const url = getEntryLink(entry);
    if (!url || seen.has(url)) {
      continue;
    }

    // Pre-check: skip entries that appear unsaved (before DOM operations)
    if (quickCheckSaved(entry) === false) {
      continue;
    }

    const button = findUnsaveButton(entry);
    if (!button) {
      continue;
    }

    seen.add(url);
    results.push({ entry, url, button });
  }

  return results;
}

async function unsaveEntry(entry, knownButton) {
  const button = knownButton || findUnsaveButton(entry);
  if (!button) {
    return false;
  }
  clickElement(button);
  await delay(100);
  return true;
}

async function revealToolbar(entry) {
  const hoverTargets = [
    entry,
    entry.querySelector(".EntryMetadataWrapper"),
    entry.querySelector(".EntryMetadataReadLater"),
    entry.querySelector("div"),
    entry.firstElementChild
  ].filter(Boolean);

  for (const target of hoverTargets) {
    const mouseInit = { bubbles: true, cancelable: true, view: window };
    target.dispatchEvent(new MouseEvent("mouseenter", mouseInit));
    target.dispatchEvent(new MouseEvent("mouseover", mouseInit));
    target.dispatchEvent(new MouseEvent("mousemove", mouseInit));
  }

  await delay(120);
}

// =============================================================================
// Event Dispatching
// =============================================================================

function clickElement(element) {
  const mouseEvents = [
    "mouseover",
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click"
  ];
  for (const type of mouseEvents) {
    element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window
      })
    );
  }
}

function activateAsButton(element) {
  element.focus({ preventScroll: true });

  const keyEvents = ["keydown", "keyup"];
  for (const key of ["Enter", " "]) {
    for (const type of keyEvents) {
      element.dispatchEvent(
        new KeyboardEvent(type, {
          bubbles: true,
          cancelable: true,
          key
        })
      );
    }
  }

  element.click();
}

// =============================================================================
// Infinite Scroll Loading
// =============================================================================

async function loadAllEntries({ maxRounds, idleThreshold }) {
  let idleRounds = 0;
  let lastCount = getEntryElements().length;
  const entries = getEntryElements();
  const scrollElement = entries.length
    ? findScrollContainer(entries[0])
    : document.scrollingElement || document.documentElement || document.body;

  for (let round = 0; round < maxRounds; round += 1) {
    scrollElement.scrollTo({
      top: scrollElement.scrollHeight,
      behavior: "auto"
    });
    await delay(800);

    const currentCount = getEntryElements().length;
    if (currentCount <= lastCount) {
      idleRounds += 1;
    } else {
      idleRounds = 0;
    }

    if (idleRounds >= idleThreshold) {
      break;
    }

    lastCount = currentCount;
  }
}

function findScrollContainer(startNode) {
  let node = startNode;
  while (node && node !== document.body) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        node.scrollHeight > node.clientHeight + 50
      ) {
        return node;
      }
    }
    node = node.parentElement;
  }

  return document.scrollingElement || document.documentElement || document.body;
}

// =============================================================================
// Main Handler
// =============================================================================

async function handleOpen(settings) {
  if (!(await waitForReadLaterPage(2000))) {
    return { ok: false, error: "This tab is not a Feedly Read Later page." };
  }

  if (settings.mode === "all") {
    await loadAllEntries({ maxRounds: 30, idleThreshold: 3 });
  }

  const selected = await getSavedEntriesWithUrls(settings);

  for (const item of selected) {
    await unsaveEntry(item.entry, item.button);
  }

  if (settings.reload) {
    setTimeout(() => {
      location.reload();
    }, 1000);
  }

  return {
    ok: true,
    urls: selected.map((item) => item.url),
    reloadScheduled: Boolean(settings.reload)
  };
}

async function waitForReadLaterPage(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isReadLaterPage(location.href)) {
      return true;
    }
    await delay(200);
  }
  return isReadLaterPage(location.href);
}

function hasReadLaterDom() {
  if (document.querySelector(".EntryMetadataReadLater")) {
    return true;
  }

  const header = document.querySelector("h1");
  if (header && /read later/i.test(header.textContent || "")) {
    return true;
  }

  const label = document.querySelector(".EntryMetadataReadLater span");
  return Boolean(label && /read later/i.test(label.textContent || ""));
}

function markReadLaterSeen(url) {
  lastReadLaterSeenAt = Date.now();
  lastReadLaterUrl = url || location.href;
}

function isRecentlyReadLater() {
  if (Date.now() - lastReadLaterSeenAt > READ_LATER_CACHE_MS) {
    return false;
  }
  return location.origin === "https://feedly.com" && lastReadLaterUrl.length > 0;
}

// =============================================================================
// Message Listener
// =============================================================================

if (!window.__feedlyReadLaterOpenerListenerAdded) {
  window.__feedlyReadLaterOpenerListenerAdded = true;
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "FEEDLY_OPEN") {
      return false;
    }

    handleOpen(message.settings || {}).then(sendResponse);
    return true;
  });
}
