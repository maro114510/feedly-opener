const api = typeof browser !== "undefined" ? browser : chrome;

// =============================================================================
// API Constants
// =============================================================================

const FEEDLY_API_BASE = "https://api.feedly.com";

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

/**
 * Normalize count value to a positive integer.
 * @param {number|undefined} count - Count value from settings
 * @returns {number} Normalized count (minimum 1)
 */
function normalizeCount(count) {
  return Math.max(count || 1, 1);
}

// =============================================================================
// Feedly API Functions
// =============================================================================

// Token storage for communication between page and content script
let cachedAccessToken = null;

/**
 * Clear the cached access token.
 * Called when authentication fails to allow re-fetching from localStorage.
 */
function clearAccessTokenCache() {
  cachedAccessToken = null;
}

/**
 * Get access token from Feedly's localStorage.
 *
 * IMPLEMENTATION NOTE:
 * Token is stored by Feedly web app in localStorage under "feedly.session" key.
 * This is an undocumented implementation detail and may change in future Feedly updates.
 * If token retrieval fails, the extension falls back to DOM-based operations.
 *
 * @returns {Promise<string|null>} Access token or null if not available
 */
async function getAccessToken() {
  // Return cached token if available
  if (cachedAccessToken) {
    return cachedAccessToken;
  }

  try {
    const sessionData = localStorage.getItem("feedly.session");
    if (sessionData) {
      const session = JSON.parse(sessionData);
      if (session.feedlyToken) {
        cachedAccessToken = session.feedlyToken;
        return cachedAccessToken;
      }
    }
  } catch (e) {
    console.warn("[Feedly Opener] Failed to get token from localStorage:", e);
  }

  return null;
}

/**
 * Make authenticated API request to Feedly.
 * @param {string} endpoint - API endpoint path
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Response JSON
 */
async function feedlyApiRequest(endpoint, options = {}) {
  const token = await getAccessToken();
  if (!token) {
    throw new Error("No Feedly access token available");
  }

  const url = `${FEEDLY_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers
    }
  });

  if (!response.ok) {
    // Clear token cache on authentication errors to allow retry with fresh token
    if (response.status === 401 || response.status === 403) {
      clearAccessTokenCache();
    }
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`Feedly API error ${response.status}: ${errorText}`);
  }

  // DELETE requests may return empty body
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return { success: true };
  }

  return response.json();
}

/**
 * Get current user's profile to extract userId.
 * @returns {Promise<string>} User ID
 */
async function getUserId() {
  const profile = await feedlyApiRequest("/v3/profile");
  if (!profile.id) {
    throw new Error("User ID not found in profile response");
  }
  return profile.id;
}

/**
 * Parse entry items from API response into normalized format.
 * @param {Array} items - Raw items from API response
 * @returns {Array} Array of entry objects with id and url
 */
function parseEntryItems(items) {
  if (!items || !Array.isArray(items)) {
    return [];
  }
  return items.map((item) => ({
    id: item.id,
    url: item.alternate?.[0]?.href || item.canonicalUrl || item.originId || null,
    title: item.title || "Untitled"
  })).filter((item) => item.url);
}

/**
 * Fetch saved entries via Feedly API.
 * @param {string} userId - User ID
 * @param {number} count - Maximum number of entries to fetch
 * @returns {Promise<Array>} Array of entry objects with id and url
 */
async function fetchSavedEntriesViaAPI(userId, count = 100) {
  const streamId = encodeURIComponent(`user/${userId}/tag/global.saved`);
  const response = await feedlyApiRequest(
    `/v3/streams/contents?streamId=${streamId}&count=${count}&ranked=newest`
  );
  return parseEntryItems(response.items);
}

/**
 * Fetch all saved entries via Feedly API using pagination.
 * Uses continuation token to fetch entries beyond the 100-item limit.
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Array of all entry objects with id and url
 */
async function fetchAllSavedEntriesViaAPI(userId) {
  const allEntries = [];
  let continuation = null;
  const PAGE_SIZE = 100;

  do {
    const streamId = encodeURIComponent(`user/${userId}/tag/global.saved`);
    let url = `/v3/streams/contents?streamId=${streamId}&count=${PAGE_SIZE}&ranked=newest`;
    if (continuation) {
      url += `&continuation=${encodeURIComponent(continuation)}`;
    }

    const response = await feedlyApiRequest(url);
    const entries = parseEntryItems(response.items);
    allEntries.push(...entries);

    continuation = response.continuation || null;
  } while (continuation);

  return allEntries;
}

/**
 * Unsave entries via API (delete from Read Later).
 * Uses parallel batch processing to improve performance while respecting rate limits.
 * @param {string} userId - User ID
 * @param {Array<string>} entryIds - Array of entry IDs to unsave
 * @returns {Promise<boolean>} Success status
 */
async function unsaveEntriesViaAPI(userId, entryIds) {
  if (!entryIds || entryIds.length === 0) {
    return true;
  }

  const tagId = encodeURIComponent(`user/${userId}/tag/global.saved`);
  const BATCH_SIZE = 5;

  // Process DELETE requests in parallel batches to balance speed and rate limiting
  for (let i = 0; i < entryIds.length; i += BATCH_SIZE) {
    const batch = entryIds.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map((entryId) =>
        feedlyApiRequest(`/v3/tags/${tagId}/${encodeURIComponent(entryId)}`, {
          method: "DELETE"
        })
      )
    );
  }
  return true;
}

/**
 * Main API-based handler for fetching and unsaving entries.
 * @param {Object} settings - Settings object with mode and count
 * @returns {Promise<Object>} Result object with ok, urls, and method
 */
async function handleOpenViaAPI(settings) {
  const token = await getAccessToken();
  if (!token) {
    throw new Error("No access token available. Please ensure you are logged into Feedly.");
  }

  const userId = await getUserId();

  // Fetch entries: use pagination for "all" mode, single request for "count" mode
  const entries = settings.mode === "all"
    ? await fetchAllSavedEntriesViaAPI(userId)
    : await fetchSavedEntriesViaAPI(userId, normalizeCount(settings.count));

  if (entries.length === 0) {
    return {
      ok: true,
      urls: [],
      method: "api",
      message: "No saved entries found"
    };
  }

  // Limit entries based on settings (only needed for "count" mode as safeguard)
  const entriesToProcess = settings.mode === "count"
    ? entries.slice(0, normalizeCount(settings.count))
    : entries;

  const entryIds = entriesToProcess.map((e) => e.id);
  await unsaveEntriesViaAPI(userId, entryIds);

  return {
    ok: true,
    urls: entriesToProcess.map((e) => e.url),
    method: "api"
  };
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
    settings.mode === "count" ? normalizeCount(settings.count) : Infinity;

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

// =============================================================================
// Infinite Scroll Loading
// =============================================================================

async function loadAllEntries({ maxRounds, idleThreshold }) {
  let idleRounds = 0;
  const entries = getEntryElements();
  let lastCount = entries.length;
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

/**
 * DOM-based handler for fetching and unsaving entries.
 * Used as fallback when API is unavailable.
 * @param {Object} settings - Settings object with mode and count
 * @returns {Promise<Object>} Result object
 */
async function handleOpenViaDOM(settings) {
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

  return {
    ok: true,
    urls: selected.map((item) => item.url),
    method: "dom"
  };
}

/**
 * Main handler: tries API first, falls back to DOM on failure.
 * @param {Object} settings - Settings object with mode and count
 * @returns {Promise<Object>} Result object
 */
async function handleOpen(settings) {
  let result;
  let apiError = null;

  // Try API-based approach first
  try {
    result = await handleOpenViaAPI(settings);
  } catch (e) {
    apiError = e;
    console.warn("[Feedly Opener] API operation failed, falling back to DOM:", e.message);
  }

  // Fallback to DOM-based approach if API failed
  if (!result || !result.ok) {
    try {
      result = await handleOpenViaDOM(settings);
      if (apiError) {
        result.apiError = apiError.message;
      }
    } catch (domError) {
      console.error("[Feedly Opener] DOM operation also failed:", domError);
      return {
        ok: false,
        error: `API error: ${apiError?.message || "unknown"}. DOM error: ${domError.message}`,
        method: "failed"
      };
    }
  }

  // Always reload after successful operation to reflect UI changes
  if (result.ok) {
    setTimeout(() => {
      location.reload();
    }, 1000);
  }

  return result;
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
