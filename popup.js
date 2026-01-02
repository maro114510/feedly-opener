const api = typeof browser !== "undefined" ? browser : chrome;
const usesPromises = typeof browser !== "undefined";

const SETTINGS_KEY = "feedlyOpenerSettings";
const DEFAULT_SETTINGS = {
  mode: "all",
  count: 10,
  reload: false
};

const storageArea =
  api.storage && api.storage.sync ? api.storage.sync : api.storage.local;

const $ = (selector) => document.querySelector(selector);
const statusEl = $("#status");
const runButton = $("#run");
const countInput = $("#count");
const reloadInput = $("#reload");
const modeInputs = Array.from(document.querySelectorAll('input[name="mode"]'));

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
    reload: reloadInput.checked
  };
}

function applySettingsToForm(settings) {
  modeInputs.forEach((input) => {
    input.checked = input.value === settings.mode;
  });
  countInput.value = settings.count;
  reloadInput.checked = settings.reload;
  updateCountDisabled(settings.mode);
}

function updateCountDisabled(mode) {
  const disabled = mode !== "count";
  countInput.disabled = disabled;
  const row = countInput.closest(".count-row");
  if (row) {
    row.style.opacity = disabled ? "0.5" : "1";
  }
}

async function loadSettings() {
  const stored = await storageGet(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

async function saveSettings(settings) {
  await storageSet({ [SETTINGS_KEY]: settings });
}

async function run() {
  setStatus("");
  runButton.disabled = true;

  try {
    const settings = readSettingsFromForm();
    await saveSettings(settings);

    const [tab] = await tabsQuery({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setStatus("No active tab found.");
      return;
    }

    let response;
    try {
      response = await tabsSendMessage(tab.id, {
        type: "FEEDLY_OPEN",
        settings
      });
    } catch (error) {
      setStatus("Open a Feedly Read Later tab first.");
      return;
    }

    if (!response || !response.ok) {
      setStatus(response?.error || "Not on Feedly Read Later page.");
      return;
    }

    const urls = response.urls || [];
    if (!urls.length) {
      setStatus("No saved items found.");
      return;
    }

    for (const url of urls) {
      await tabsCreate({ url, active: false });
    }

    const suffix = response.reloadScheduled ? " Reloading page." : "";
    setStatus(`Opened ${urls.length} tabs.${suffix}`);
  } catch (error) {
    setStatus("Failed to open tabs. Please try again.");
  } finally {
    runButton.disabled = false;
  }
}

async function init() {
  const settings = await loadSettings();
  applySettingsToForm(settings);

  modeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      updateCountDisabled(input.value);
    });
  });

  runButton.addEventListener("click", run);
}

init();
