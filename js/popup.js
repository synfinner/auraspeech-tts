const STREAMING_TTS_MODEL = "gpt-4o-mini-tts-2025-12-15";
const LOCAL_API_KEY_KEY = "secureApiKey";
const SESSION_API_KEY_KEY = "apiKey";

document.addEventListener("DOMContentLoaded", () => {
  const ui = {
    apiKey: document.getElementById("apiKey"),
    voice: document.getElementById("voice"),
    speed: document.getElementById("speed"),
    speedValue: document.getElementById("speedValue"),
    instructions: document.getElementById("instructions"),
    saveSettings: document.getElementById("saveSettings"),
    status: document.getElementById("status")
  };

  let statusTimer = null;
  let hasSavedApiKey = false;
  let baselineSettings = null;
  ui.saveSettings.disabled = true;

  ui.speed.addEventListener("input", () => {
    ui.speedValue.textContent = `${Number(ui.speed.value).toFixed(2)}x`;
    updateSaveButtonState();
  });
  ui.voice.addEventListener("change", updateSaveButtonState);
  ui.instructions.addEventListener("input", updateSaveButtonState);
  ui.apiKey.addEventListener("input", updateSaveButtonState);

  ui.saveSettings.addEventListener("click", async () => {
    const enteredApiKey = normalizeApiKey(ui.apiKey.value);
    const existingApiKey = await getPersistentApiKey();
    const effectiveApiKey = enteredApiKey || existingApiKey;

    if (!effectiveApiKey) {
      setStatus("Please enter your OpenAI API key.", "error");
      return;
    }

    if (enteredApiKey) {
      const saved = await setPersistentApiKey(enteredApiKey);
      if (!saved) {
        setStatus("Unable to store API key securely.", "error");
        return;
      }
    }

    await removeLegacyApiKeyFromLocalStorage();

    const settings = {
      voice: ui.voice.value,
      speed: Number(ui.speed.value),
      model: STREAMING_TTS_MODEL,
      instructions: ui.instructions.value.trim(),
      inPageControlsEnabled: true
    };

    await chrome.storage.local.set({
      settings,
      voice: settings.voice,
      accessibilitySettings: { speed: settings.speed }
    });

    ui.apiKey.value = "";
    ui.apiKey.placeholder = "API key stored securely on this device";

    await sendSettingsToActiveTab({
      inPageControlsEnabled: true
    });

    hasSavedApiKey = true;
    baselineSettings = getCurrentSettingsSnapshot(ui);
    updateSaveButtonState();
    setStatus("Settings saved.", "success");
  });

  void init();

  async function init() {
    const settings = await loadSettings();

    ui.apiKey.value = "";
    ui.apiKey.placeholder = settings.hasApiKey
      ? "API key stored securely on this device (leave blank to keep)"
      : "sk-...";
    ui.voice.value = settings.voice;
    syncSpeedUi(settings.speed);
    ui.instructions.value = settings.instructions;
    hasSavedApiKey = Boolean(settings.hasApiKey);
    baselineSettings = getCurrentSettingsSnapshot(ui);
    updateSaveButtonState();
  }

  function syncSpeedUi(speed) {
    const clamped = Math.min(4, Math.max(0.25, Number(speed || 1)));
    ui.speed.value = String(clamped);
    ui.speedValue.textContent = `${clamped.toFixed(2)}x`;
  }

  function setStatus(message, kind = "") {
    ui.status.textContent = message;
    ui.status.className = `status ${kind}`.trim();

    if (statusTimer) {
      clearTimeout(statusTimer);
    }

    statusTimer = setTimeout(() => {
      ui.status.textContent = "";
      ui.status.className = "status";
    }, 4000);
  }

  function updateSaveButtonState() {
    const hasTypedApiKey = normalizeApiKey(ui.apiKey.value).length > 0;
    const hasNonKeyChanges = isNonKeySettingsDirty(ui, baselineSettings);
    ui.saveSettings.disabled = !(hasTypedApiKey || (hasSavedApiKey && hasNonKeyChanges));
  }
});

async function sendSettingsToActiveTab(settings) {
  const [activeTab] = await chrome.tabs
    .query({ active: true, currentWindow: true })
    .catch(() => [null]);
  if (!activeTab?.id) {
    return;
  }

  await new Promise((resolve) => {
    chrome.tabs.sendMessage(activeTab.id, { action: "settingsChanged", settings }, () => {
      resolve();
    });
  });
}

async function loadSettings() {
  const [stored, sessionStored] = await Promise.all([
    chrome.storage.local.get([
      "settings",
      LOCAL_API_KEY_KEY,
      "apiKey",
      "voice",
      "accessibilitySettings"
    ]),
    getSessionStorageSafe([SESSION_API_KEY_KEY])
  ]);

  const settings = {
    hasApiKey: false,
    voice: "marin",
    speed: 1,
    inPageControlsEnabled: true,
    model: STREAMING_TTS_MODEL,
    instructions:
      "Read naturally like a polished podcast narrator. Keep pacing smooth, pronunciation clear, and tone engaging without sounding theatrical."
  };

  if (stored.settings) {
    Object.assign(settings, sanitizeSettingsForStorage(stored.settings));
  }

  const localSecureApiKey = normalizeApiKey(stored?.[LOCAL_API_KEY_KEY]);
  const sessionApiKey = normalizeApiKey(sessionStored?.[SESSION_API_KEY_KEY]);
  const legacyApiKey =
    normalizeApiKey(stored.apiKey) || normalizeApiKey(stored.settings?.apiKey);
  const effectiveApiKey = localSecureApiKey || sessionApiKey || legacyApiKey;

  if (effectiveApiKey && localSecureApiKey !== effectiveApiKey) {
    const migrated = await setPersistentApiKey(effectiveApiKey);
    if (migrated) {
      await removeLegacyApiKeyFromLocalStorage();
    }
  }

  settings.hasApiKey = Boolean(effectiveApiKey);

  if (!stored.settings?.voice && stored.voice) {
    settings.voice = stored.voice;
  }

  if (!stored.settings?.speed && stored.accessibilitySettings?.speed) {
    settings.speed = Number(stored.accessibilitySettings.speed);
  }

  settings.speed = Number.isFinite(Number(settings.speed)) ? Number(settings.speed) : 1;
  settings.model = STREAMING_TTS_MODEL;
  settings.inPageControlsEnabled = true;
  return settings;
}

function sanitizeSettingsForStorage(settings) {
  const sanitized = {
    ...(settings || {})
  };

  delete sanitized.apiKey;
  return sanitized;
}

function getCurrentSettingsSnapshot(ui) {
  return {
    voice: String(ui.voice.value || "marin"),
    speed: Number(ui.speed.value),
    instructions: String(ui.instructions.value || "").trim()
  };
}

function isNonKeySettingsDirty(ui, baseline) {
  if (!baseline) {
    return false;
  }

  const current = getCurrentSettingsSnapshot(ui);
  return (
    current.voice !== baseline.voice ||
    Math.abs(current.speed - baseline.speed) >= 0.0001 ||
    current.instructions !== baseline.instructions
  );
}

function normalizeApiKey(value) {
  return String(value || "").trim();
}

async function getSessionStorageSafe(keys) {
  if (!chrome.storage?.session) {
    return {};
  }

  try {
    return await chrome.storage.session.get(keys);
  } catch (_error) {
    return {};
  }
}

async function getSessionApiKey() {
  const stored = await getSessionStorageSafe([SESSION_API_KEY_KEY]);
  return normalizeApiKey(stored?.[SESSION_API_KEY_KEY]);
}

async function getPersistentApiKey() {
  const [localStored, sessionApiKey] = await Promise.all([
    chrome.storage.local.get([LOCAL_API_KEY_KEY]),
    getSessionApiKey()
  ]);

  return normalizeApiKey(localStored?.[LOCAL_API_KEY_KEY]) || sessionApiKey;
}

async function setSessionApiKey(apiKey) {
  if (!chrome.storage?.session) {
    return false;
  }

  const normalized = normalizeApiKey(apiKey);
  if (!normalized) {
    return false;
  }

  try {
    await chrome.storage.session.set({ [SESSION_API_KEY_KEY]: normalized });
    return true;
  } catch (_error) {
    return false;
  }
}

async function setPersistentApiKey(apiKey) {
  const normalized = normalizeApiKey(apiKey);
  if (!normalized) {
    return false;
  }

  try {
    await chrome.storage.local.set({ [LOCAL_API_KEY_KEY]: normalized });
    await setSessionApiKey(normalized);
    return true;
  } catch (_error) {
    return false;
  }
}

async function removeLegacyApiKeyFromLocalStorage() {
  const stored = await chrome.storage.local.get(["settings", "apiKey"]);
  const writes = {};

  if (stored.settings?.apiKey) {
    writes.settings = sanitizeSettingsForStorage(stored.settings);
  }

  if (Object.keys(writes).length) {
    await chrome.storage.local.set(writes);
  }

  if (normalizeApiKey(stored.apiKey)) {
    await chrome.storage.local.remove(["apiKey"]);
  }
}
