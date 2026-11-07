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
  constructor(code, technicalDetail, status = null) {
    super(technicalDetail);
    this.name = 'FeedlyError';
    this.code = code;
    this.status = status;
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
const PAGE_SIZE = 100;
const MAX_PAGINATION_PAGES = 1000;
const MAX_CONTINUATION_LENGTH = 4096;
const MAX_ITEMS_PER_RUN = 200;

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
  return Math.min(Math.max(count || 1, 1), MAX_ITEMS_PER_RUN);
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
      `API ${response.status}: ${errorBody.substring(0, 200)}`,
      response.status
    );
  }

  const responseBody = await response.text();
  if (!responseBody.trim()) {
    return { success: true };
  }

  try {
    return JSON.parse(responseBody);
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
    const url = urlCandidates.map(normalizeEntryUrl).find(Boolean) || null;

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
 * @returns {Promise<Array<{id: string, status: "unsaved"|"failed"}>>} Result per entry
 */
async function unsaveEntriesViaAPI(userId, entryIds) {
  if (!entryIds || entryIds.length === 0) {
    return [];
  }

  const tagId = encodeURIComponent(`user/${userId}/tag/global.saved`);
  const BATCH_SIZE = 5;
  const allResults = [];

  // Process DELETE requests in parallel batches to balance speed and rate limiting
  for (let i = 0; i < entryIds.length; i += BATCH_SIZE) {
    const batch = entryIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((entryId) =>
        feedlyApiRequest(`/v3/tags/${tagId}/${encodeURIComponent(entryId)}`, {
          method: "DELETE"
        }).then(() => ({ id: entryId, status: "unsaved" }))
      )
    );
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "fulfilled") {
        allResults.push(result.value);
      } else {
        const entryId = batch[index];
        allResults.push({
          id: entryId,
          status: result.reason?.status === 404 || result.reason?.status === 410
            ? "unsaved"
            : "failed"
        });
      }
    }
  }
  return allResults;
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

  // Limit entries based on settings and enforce the hard per-run cap.
  const entriesToProcess = entries.slice(
    0,
    settings.mode === "count" ? normalizeCount(settings.count) : MAX_ITEMS_PER_RUN
  );
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

  return isRecentlyReadLater();
}

function normalizeEntryUrl(href) {
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
// Main Handler
// =============================================================================

/**
 * Main API handler.
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

  try {
    return await handleOpenViaAPI(settings);
  } catch (e) {
    if (e instanceof FeedlyError) {
      console.warn("[Feedly Opener] API failed:", e.getDebugInfo());
    } else {
      console.warn("[Feedly Opener] API failed:", e?.message || e);
    }
    const userMessage = e instanceof FeedlyError ? e.getUserMessage() : UserMessages.UNKNOWN;
    return { ok: false, error: userMessage, method: "failed" };
  }
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
  const results = [];

  if (pending.type === "api" && verifiedTargets.length > 0) {
    results.push(...await unsaveEntriesViaAPI(
      pending.userId,
      verifiedTargets.map((target) => target.id)
    ));
    unsavedCount = results.filter((result) => result.status === "unsaved").length;
  }

  if (pending.settings.reload && verifiedTargets.length > 0) {
    setTimeout(() => {
      location.reload();
    }, 1000);
  }

  return {
    ok: true,
    unsavedCount,
    skippedCount,
    failedCount: results.filter((result) => result.status === "failed").length,
    failedIds: results
      .filter((result) => result.status === "failed")
      .map((result) => result.id),
    results
  };
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
