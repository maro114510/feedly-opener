const api = typeof browser !== "undefined" ? browser : chrome;
const usesPromises = typeof browser !== "undefined";

const SETTINGS_KEY = "feedlyOpenerSettings";
const DEFAULT_SETTINGS = {
  mode: "all",
  count: 10,
  reload: true
};

const storageArea =
  api.storage && api.storage.sync ? api.storage.sync : api.storage.local;

const $ = (selector) => document.querySelector(selector);
const statusEl = $("#status");
const runButton = $("#run");
const countInput = $("#count");
const modeInputs = Array.from(document.querySelectorAll('input[name="mode"]'));

// =============================================================================
// Loading Manager
// =============================================================================

const LoadingManager = {
  container: null,
  spinner: null,
  text: null,
  hideTimeout: null,

  init() {
    this.container = $("#loading-container");
    this.spinner = $("#spinner");
    this.text = $("#loading-text");
  },

  show(message = "Processing...") {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    if (this.container) this.container.classList.add("active");
    if (this.spinner) this.spinner.classList.remove("error", "success");
    if (this.text) this.text.textContent = message;
    if (runButton) runButton.classList.add("loading");
  },

  hide() {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    if (this.container) this.container.classList.remove("active");
    if (runButton) runButton.classList.remove("loading");
  },

  showError(message = "Error") {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    if (this.spinner) {
      this.spinner.classList.add("error");
      this.spinner.classList.remove("success");
    }
    if (this.text) this.text.textContent = message;
    this.hideTimeout = setTimeout(() => this.hide(), 2000);
  },

  showSuccess(message = "Done!") {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    if (this.spinner) {
      this.spinner.classList.add("success");
      this.spinner.classList.remove("error");
    }
    if (this.text) this.text.textContent = message;
    this.hideTimeout = setTimeout(() => this.hide(), 1500);
  }
};

// =============================================================================
// Storage Functions
// =============================================================================

function storageGet(keys) {
  if (usesPromises) {
    return storageArea.get(keys);
  }

  return new Promise((resolve, reject) => {
    storageArea.get(keys, (result) => {
      const error = api.runtime && api.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(values) {
  if (usesPromises) {
    return storageArea.set(values);
  }

  return new Promise((resolve, reject) => {
    storageArea.set(values, () => {
      const error = api.runtime && api.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function tabsQuery(query) {
  if (usesPromises) {
    return api.tabs.query(query);
  }

  return new Promise((resolve, reject) => {
    api.tabs.query(query, (tabs) => {
      const error = api.runtime && api.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(tabs);
    });
  });
}

function tabsSendMessage(tabId, message) {
  if (usesPromises) {
    return api.tabs.sendMessage(tabId, message);
  }

  return new Promise((resolve, reject) => {
    api.tabs.sendMessage(tabId, message, (response) => {
      const error = api.runtime && api.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

function tabsCreate(createProperties) {
  if (usesPromises) {
    return api.tabs.create(createProperties);
  }

  return new Promise((resolve, reject) => {
    api.tabs.create(createProperties, (tab) => {
      const error = api.runtime && api.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(tab);
    });
  });
}

// =============================================================================
// UI Functions
// =============================================================================

function setStatus(message) {
  statusEl.textContent = message || "";
}

function clampCount(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_SETTINGS.count;
  }
  return Math.min(Math.max(value, 1), 999);
}

function readSettingsFromForm() {
  const mode =
    modeInputs.find((input) => input.checked)?.value || DEFAULT_SETTINGS.mode;
  const count = clampCount(Number.parseInt(countInput.value, 10));

  return {
    mode,
    count,
    reload: DEFAULT_SETTINGS.reload
  };
}

function applySettingsToForm(settings) {
  modeInputs.forEach((input) => {
    input.checked = input.value === settings.mode;
  });
  countInput.value = settings.count;
  updateCountDisabled(settings.mode);
}

function updateCountDisabled(mode) {
  const disabled = mode !== "count";
  countInput.disabled = disabled;
  const inlineGroup = countInput.closest(".inline-count");
  if (inlineGroup) {
    inlineGroup.style.opacity = disabled ? "0.5" : "1";
  }
}

async function loadSettings() {
  const stored = await storageGet(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

async function saveSettings(settings) {
  await storageSet({ [SETTINGS_KEY]: settings });
}

// =============================================================================
// Main Run Function
// =============================================================================

async function run() {
  setStatus("");
  runButton.disabled = true;
  LoadingManager.show("Processing...");

  try {
    const settings = readSettingsFromForm();

    const [tab] = await tabsQuery({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setStatus("No active tab found.");
      LoadingManager.showError("No tab");
      return;
    }

    let response;
    try {
      response = await tabsSendMessage(tab.id, {
        type: "FEEDLY_OPEN",
        settings
      });
    } catch (error) {
      response = await ensureContentScript(tab, settings);
      if (!response) {
        setStatus("Open a Feedly Read Later tab first.");
        LoadingManager.showError("Wrong page");
        return;
      }
    }

    if (!response || !response.ok) {
      setStatus(response?.error || "Not on Feedly Read Later page.");
      LoadingManager.showError("Error");
      return;
    }

    const urls = response.urls || [];
    if (!urls.length) {
      setStatus("No saved items found.");
      LoadingManager.hide();
      return;
    }

    for (const url of urls) {
      await tabsCreate({ url, active: false });
    }

    setStatus(`Opened ${urls.length} tabs. Reloading page.`);
    LoadingManager.showSuccess(`${urls.length} opened`);
  } catch (error) {
    setStatus("Failed to open tabs. Please try again.");
    LoadingManager.showError("Failed");
  } finally {
    runButton.disabled = false;
  }
}

// =============================================================================
// Initialization
// =============================================================================

async function init() {
  LoadingManager.init();

  const settings = await loadSettings();
  applySettingsToForm(settings);

  // Save settings immediately when changed
  modeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      updateCountDisabled(input.value);
      saveSettings(readSettingsFromForm());
    });
  });

  countInput.addEventListener("input", () => {
    saveSettings(readSettingsFromForm());
  });

  runButton.addEventListener("click", run);
}

init();

// =============================================================================
// Content Script Injection
// =============================================================================

async function ensureContentScript(tab, settings) {
  try {
    await tabsExecuteScript(tab.id, "content.js");
  } catch (error) {
    return null;
  }

  await delay(100);
  try {
    return await tabsSendMessage(tab.id, { type: "FEEDLY_OPEN", settings });
  } catch (error) {
    return null;
  }
}

function tabsExecuteScript(tabId, file) {
  if (api.scripting && api.scripting.executeScript) {
    return api.scripting.executeScript({
      target: { tabId },
      files: [file]
    });
  }

  return new Promise((resolve, reject) => {
    api.tabs.executeScript(tabId, { file }, () => {
      const error = api.runtime && api.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
