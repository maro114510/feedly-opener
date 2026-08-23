const api = typeof browser !== "undefined" ? browser : chrome;

// =============================================================================
// API Constants
// =============================================================================

const FEEDLY_API_BASE = "https://api.feedly.com";
const TOKEN_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// =============================================================================
// Error Handling
// =============================================================================

const ErrorCode = {
  NO_TOKEN: 'NO_TOKEN',
  AUTH_FAILED: 'AUTH_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVER_ERROR: 'SERVER_ERROR',
  CLIENT_ERROR: 'CLIENT_ERROR',
  WRONG_PAGE: 'WRONG_PAGE',
  DOM_CHANGED: 'DOM_CHANGED',
  UNKNOWN: 'UNKNOWN'
};

const UserMessages = {
  NO_TOKEN: "Please sign in to Feedly first.",
  AUTH_FAILED: "Authentication failed. Please sign in to Feedly again.",
  RATE_LIMITED: "Too many requests. Please wait a moment.",
  NETWORK_ERROR: "Network error. Please check your connection.",
  SERVER_ERROR: "Feedly service is temporarily unavailable.",
  CLIENT_ERROR: "Invalid request. Please try again.",
  WRONG_PAGE: "Please open a Feedly Read Later page.",
  DOM_CHANGED: "Feedly page changed before unsave. Please retry.",
  UNKNOWN: "Something went wrong. Please try again."
};

class FeedlyError extends Error {
  constructor(code, technicalDetail) {
    super(technicalDetail);
    this.name = 'FeedlyError';
    this.code = code;
    this.userMessage = UserMessages[code] || UserMessages.UNKNOWN;
  }

  getUserMessage() {
    return this.userMessage;
  }

  getDebugInfo() {
    return `[${this.code}] ${this.message}`;
  }
}

function classifyHttpError(status) {
  if (status === 401 || status === 403) return ErrorCode.AUTH_FAILED;
  if (status === 429) return ErrorCode.RATE_LIMITED;
  if (status >= 500) return ErrorCode.SERVER_ERROR;
  if (status >= 400) return ErrorCode.CLIENT_ERROR;
  return ErrorCode.UNKNOWN;
}

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
const PAGE_SIZE = 100;
const MAX_PAGINATION_PAGES = 1000;
const MAX_CONTINUATION_LENGTH = 4096;

const SavedState = Object.freeze({
  SAVED: "saved",
  UNSAVED: "unsaved",
  UNKNOWN: "unknown"
});

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

// Token storage with metadata for TTL and change detection
let tokenCache = {
  token: null,
  cachedAt: 0,
  sourceHash: null
};

// Pending unsave state held between FEEDLY_OPEN and FEEDLY_UNSAVE messages.
// { type: "api", userId, targets: [{ id, url }], settings }
// | { type: "dom", items: [{id, entry, url, button}], targets, settings }
let pendingUnsave = null;

/**
 * Generate a simple hash for change detection (djb2 algorithm).
 * @param {string} str - String to hash
 * @returns {number} Simple numeric hash
 */
function simpleHash(str) {
  if (!str) return 0;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash | 0;  // Convert to 32-bit signed integer
  }
  return hash;
}

/**
 * Check if cached token is still valid.
 * Validates TTL expiration and localStorage data integrity.
 * @returns {boolean} True if cache is valid
 */
function isTokenCacheValid() {
  if (!tokenCache.token) {
    return false;
  }

  // Check TTL expiration
  if (Date.now() - tokenCache.cachedAt > TOKEN_CACHE_TTL_MS) {
    return false;
  }

  // Validate against current localStorage
  try {
    const currentSessionData = localStorage.getItem("feedly.session");
    if (simpleHash(currentSessionData) !== tokenCache.sourceHash) {
      return false;
    }
  } catch (e) {
    return false;
  }

  return true;
}

/**
 * Clear the cached access token.
 * Called when authentication fails to allow re-fetching from localStorage.
 */
function clearAccessTokenCache() {
  tokenCache = {
    token: null,
    cachedAt: 0,
    sourceHash: null
  };
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
  // Return cached token if still valid
  if (isTokenCacheValid()) {
    return tokenCache.token;
  }

  // Clear expired/invalid cache
  clearAccessTokenCache();

  try {
    const sessionData = localStorage.getItem("feedly.session");
    if (sessionData) {
      const session = JSON.parse(sessionData);
      if (session.feedlyToken) {
        tokenCache = {
          token: session.feedlyToken,
          cachedAt: Date.now(),
          sourceHash: simpleHash(sessionData)
        };
        return tokenCache.token;
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
    throw new FeedlyError(ErrorCode.NO_TOKEN, 'No access token in localStorage');
  }

  const url = `${FEEDLY_API_BASE}${endpoint}`;

  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers
      }
    });
  } catch (networkError) {
    throw new FeedlyError(
      ErrorCode.NETWORK_ERROR,
      `Fetch failed: ${networkError.message}`
    );
  }

  if (!response.ok) {
    // Clear token cache on authentication errors to allow retry with fresh token
    if (response.status === 401 || response.status === 403) {
      clearAccessTokenCache();
    }
    const errorBody = await response.text().catch(() => "");
    throw new FeedlyError(
      classifyHttpError(response.status),
      `API ${response.status}: ${errorBody.substring(0, 200)}`
    );
  }

  // DELETE requests may return empty body
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return { success: true };
  }

  try {
    return await response.json();
  } catch (parseError) {
    throw new FeedlyError(
      ErrorCode.SERVER_ERROR,
      `Invalid JSON response: ${parseError.message}`
    );
  }
}

/**
 * Get current user's profile to extract userId.
 * @returns {Promise<string>} User ID
 */
async function getUserId() {
  const profile = await feedlyApiRequest("/v3/profile");
  if (!profile.id) {
    throw new FeedlyError(ErrorCode.SERVER_ERROR, "User ID not found in profile response");
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

  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }

    const id = normalizeEntryId(item.id);
    const urlCandidates = [];
    if (Array.isArray(item.alternate)) {
      for (const alternate of item.alternate) {
        if (alternate && typeof alternate === "object") {
          urlCandidates.push(alternate.href);
        }
      }
    }
    urlCandidates.push(item.canonicalUrl, item.originId);
    const url = urlCandidates.map(toOpenableUrl).find(Boolean) || null;

    if (!id || !url) {
      return null;
    }

    return {
      id,
      url,
      title: typeof item.title === "string" && item.title.trim()
        ? item.title
        : "Untitled"
    };
  }).filter(Boolean);
}

function normalizeEntryId(value) {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const id = String(value).trim();
  return id || null;
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
  return parseEntryItems(response?.items);
}

/**
 * Fetch all saved entries via Feedly API using pagination.
 * Uses continuation token to fetch entries beyond the 100-item limit.
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Array of all entry objects with id and url
 */
async function fetchAllSavedEntriesViaAPI(userId) {
  const allEntries = [];
  const seenEntryIds = new Set();
  const seenUrls = new Set();
  const seenContinuations = new Set();
  let continuation = null;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    if (continuation !== null) {
      if (!isValidContinuation(continuation) || seenContinuations.has(continuation)) {
        console.warn("[Feedly Opener] Stopping pagination on invalid or repeated continuation token");
        return allEntries;
      }
      seenContinuations.add(continuation);
    }

    const streamId = encodeURIComponent(`user/${userId}/tag/global.saved`);
    let url = `/v3/streams/contents?streamId=${streamId}&count=${PAGE_SIZE}&ranked=newest`;
    if (continuation) {
      url += `&continuation=${encodeURIComponent(continuation)}`;
    }

    const response = await feedlyApiRequest(url);
    const entries = parseEntryItems(response?.items);
    for (const entry of entries) {
      if (seenEntryIds.has(entry.id) || seenUrls.has(entry.url)) {
        continue;
      }
      seenEntryIds.add(entry.id);
      seenUrls.add(entry.url);
      allEntries.push(entry);
    }

    const nextContinuation = response?.continuation;
    if (nextContinuation === undefined || nextContinuation === null || nextContinuation === "") {
      return allEntries;
    }
    if (!isValidContinuation(nextContinuation)) {
      console.warn("[Feedly Opener] Stopping pagination on malformed continuation token");
      return allEntries;
    }
    continuation = nextContinuation;
  }

  console.warn(`[Feedly Opener] Pagination stopped after ${MAX_PAGINATION_PAGES} pages`);

  return allEntries;
}

function isValidContinuation(value) {
  return typeof value === "string" &&
    value.length <= MAX_CONTINUATION_LENGTH &&
    value.trim() === value &&
    value.length > 0;
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
  // Token check is handled by feedlyApiRequest() called from getUserId()
  const userId = await getUserId();

  // Fetch entries: use pagination for "all" mode, single request for "count" mode
  const entries = settings.mode === "all"
    ? await fetchAllSavedEntriesViaAPI(userId)
    : await fetchSavedEntriesViaAPI(userId, normalizeCount(settings.count));

  if (entries.length === 0) {
    return {
      ok: true,
      urls: [],
      targets: [],
      method: "api",
      message: "No saved entries found"
    };
  }

  // Limit entries based on settings (only needed for "count" mode as safeguard)
  const entriesToProcess = settings.mode === "count"
    ? entries.slice(0, normalizeCount(settings.count))
    : entries;
  const targets = entriesToProcess.map((entry) => ({
    id: String(entry.id),
    url: entry.url
  }));

  pendingUnsave = {
    type: "api",
    userId,
    targets,
    settings
  };

  return {
    ok: true,
    urls: targets.map((target) => target.url),
    targets,
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
  if (typeof href !== "string" || !href.trim()) {
    return null;
  }

  let url;
  try {
    url = new URL(href.trim(), location.href);
  } catch (error) {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol) ||
      !url.hostname || url.username || url.password) {
    return null;
  }

  if (url.origin === location.origin) {
    if (!/^\/i\/entry\/[^/]+/i.test(url.pathname)) {
      return null;
    }
  }

  return url.toString();
}

// =============================================================================
// Save State Detection
// =============================================================================

function hasAccentClass(element) {
  return hasClassPrefix(element, "color--accent");
}

function hasSecondaryClass(element) {
  return hasClassPrefix(element, "color--secondary");
}

function hasClassPrefix(element, prefix) {
  if (!element) {
    return false;
  }
  const classAttr = typeof element.getAttribute === "function"
    ? element.getAttribute("class") || ""
    : "";
  const classNames = classAttr.split(/\s+/).filter(Boolean);
  if (element.classList) {
    classNames.push(...Array.from(element.classList));
  }
  return classNames.some((className) => className.startsWith(prefix));
}

function getSavedState(button) {
  if (!button || typeof button.querySelector !== "function") {
    return SavedState.UNKNOWN;
  }

  const svg = button.querySelector("svg");
  const states = [];
  const styledElements = [button, svg].filter(Boolean);
  if (styledElements.some(hasSecondaryClass)) {
    states.push(SavedState.UNSAVED);
  }
  if (styledElements.some(hasAccentClass)) {
    states.push(SavedState.SAVED);
  }

  const paths = typeof button.querySelectorAll === "function"
    ? Array.from(button.querySelectorAll("svg path[d]"))
    : [];
  for (const path of paths) {
    const pathData = (path.getAttribute("d") || "").trim();
    if (pathData.startsWith(BOOKMARK_ICON_UNSELECTED_PATH)) {
      states.push(SavedState.UNSAVED);
    }
    if (pathData.startsWith(BOOKMARK_ICON_SELECTED_PATH)) {
      states.push(SavedState.SAVED);
    }
  }

  const uniqueStates = [...new Set(states)];
  if (uniqueStates.length !== 1) {
    return SavedState.UNKNOWN;
  }
  return uniqueStates[0];
}

function isSavedButton(button) {
  return getSavedState(button) === SavedState.SAVED;
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
    const state = getSavedState(toolbarButton);
    if (state !== SavedState.UNKNOWN) {
      return state === SavedState.SAVED;
    }
  }

  const metaButton = entry.querySelector(READ_LATER_SELECTORS.join(","));
  if (metaButton) {
    const btn = metaButton.closest("a,button") || metaButton;
    const state = getSavedState(btn);
    if (state !== SavedState.UNKNOWN) {
      return state === SavedState.SAVED;
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
    results.push({ id: url, entry, url, button });
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
    throw new FeedlyError(ErrorCode.WRONG_PAGE, `Not on Read Later page: ${location.href}`);
  }

  if (settings.mode === "all") {
    await loadAllEntries({ maxRounds: 30, idleThreshold: 3 });
  }

  const selected = await getSavedEntriesWithUrls(settings);

  const targets = selected.map((item) => ({
    id: item.id,
    url: item.url
  }));

  pendingUnsave = selected.length > 0
    ? {
      type: "dom",
      items: selected,
      targets,
      settings
    }
    : null;

  return {
    ok: true,
    urls: targets.map((target) => target.url),
    targets,
    method: "dom"
  };
}

/**
 * Main handler: tries API first, falls back to DOM on failure.
 * @param {Object} settings - Settings object with mode and count
 * @returns {Promise<Object>} Result object
 */
async function handleOpen(settings) {
  if (!isReadLaterPage(location.href)) {
    return {
      ok: false,
      error: UserMessages.WRONG_PAGE,
      method: "failed"
    };
  }

  let result;
  let apiError = null;

  // Try API-based approach first
  try {
    result = await handleOpenViaAPI(settings);
  } catch (e) {
    apiError = e;
    if (e instanceof FeedlyError) {
      console.warn("[Feedly Opener] API failed:", e.getDebugInfo());
    } else {
      console.warn("[Feedly Opener] API failed:", e.message);
    }
  }

  // Fallback to DOM-based approach if API failed
  if (!result || !result.ok) {
    try {
      result = await handleOpenViaDOM(settings);
    } catch (domError) {
      if (domError instanceof FeedlyError) {
        console.error("[Feedly Opener] DOM failed:", domError.getDebugInfo());
      } else {
        console.error("[Feedly Opener] DOM failed:", domError.message);
      }

      // Prioritize DOM WRONG_PAGE error as it's more actionable for users
      let userMessage;
      if (domError instanceof FeedlyError && domError.code === ErrorCode.WRONG_PAGE) {
        userMessage = domError.getUserMessage();
      } else if (apiError instanceof FeedlyError) {
        userMessage = apiError.getUserMessage();
      } else {
        userMessage = UserMessages.UNKNOWN;
      }

      return {
        ok: false,
        error: userMessage,
        method: "failed"
      };
    }
  }

  return result;
}

/**
 * Execute the pending unsave and trigger page reload.
 * Called by popup after all background tabs have been opened.
 * @returns {Promise<Object>} Result object
 */
async function handleUnsave(verifiedTargetIds) {
  if (!pendingUnsave) {
    return { ok: false, error: "No pending unsave state" };
  }

  const pending = pendingUnsave;
  pendingUnsave = null;
  const verifiedIds = new Set(
    Array.isArray(verifiedTargetIds)
      ? verifiedTargetIds.filter((id) => typeof id === "string")
      : []
  );
  const verifiedTargets = pending.targets.filter((target) => verifiedIds.has(target.id));
  let unsavedCount = 0;
  let skippedCount = pending.targets.length - verifiedTargets.length;

  if (pending.type === "api") {
    await unsaveEntriesViaAPI(
      pending.userId,
      verifiedTargets.map((target) => target.id)
    );
    unsavedCount = verifiedTargets.length;
  } else {
    for (const item of pending.items.filter((item) => verifiedIds.has(item.id))) {
      if (item.button && !document.contains(item.button)) {
        skippedCount += 1;
        continue;
      }
      if (await unsaveEntry(item.entry, item.button)) {
        unsavedCount += 1;
      } else {
        skippedCount += 1;
      }
    }
  }

  if (pending.settings.reload) {
    setTimeout(() => {
      location.reload();
    }, 1000);
  }

  return {
    ok: true,
    unsavedCount,
    skippedCount
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
// Message Security
// =============================================================================

/**
 * Validate message sender is from our own extension.
 * NOTE: This is defense-in-depth. Messages via runtime.onMessage
 * should only come from our extension, but we validate explicitly
 * to ensure messages are from the expected source.
 * @param {Object} sender - Message sender object
 * @returns {boolean} True if sender is valid
 */
function validateSender(sender) {
  return sender && sender.id === api.runtime.id;
}

/**
 * Validate and sanitize settings from message.
 * @param {Object} raw - Raw settings object from message
 * @returns {Object} Validated settings with safe defaults
 */
function validateSettings(raw) {
  const validModes = ['all', 'count'];
  const rawCount = Number(raw?.count);
  const parsedCount = Number.isFinite(rawCount) ? Math.floor(rawCount) : 10;
  const safeCount = parsedCount > 0 ? parsedCount : 10;
  return {
    mode: validModes.includes(raw?.mode) ? raw.mode : 'all',
    count: Math.max(1, Math.min(999, safeCount)),
    reload: typeof raw?.reload === 'boolean' ? raw.reload : true
  };
}

// =============================================================================
// Message Listener
// =============================================================================

if (!window.__feedlyReadLaterOpenerListenerAdded) {
  window.__feedlyReadLaterOpenerListenerAdded = true;
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "FEEDLY_OPEN") {
      if (!validateSender(sender)) {
        sendResponse({ ok: false, error: "Invalid message sender" });
        return true;
      }
      const settings = validateSettings(message.settings);
      handleOpen(settings)
        .then(sendResponse)
        .catch((e) => {
          console.error("[Feedly Opener]", e);
          const userMessage = e instanceof FeedlyError ? e.getUserMessage() : UserMessages.UNKNOWN;
          sendResponse({ ok: false, error: userMessage });
        });
      return true;
    }

    if (message?.type === "FEEDLY_UNSAVE") {
      if (!validateSender(sender)) {
        sendResponse({ ok: false, error: "Invalid message sender" });
        return true;
      }
      handleUnsave(message.verifiedTargetIds)
        .then(sendResponse)
        .catch((e) => {
          console.error("[Feedly Opener]", e);
          const userMessage = e instanceof FeedlyError ? e.getUserMessage() : UserMessages.UNKNOWN;
          sendResponse({ ok: false, error: userMessage });
        });
      return true;
    }

    return false;
  });
}
