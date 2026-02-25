const OPENAI_SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const CONTEXT_MENU_SPEAK_SELECTION = "auraspeech-speak-selection";
const CONTEXT_MENU_SPEAK_ARTICLE = "auraspeech-speak-article";
const STREAMING_TTS_MODEL = "gpt-4o-mini-tts-2025-12-15";

const MAX_TTS_CHARS = 3900;
const MIN_TARGET_CHUNK_CHARS = 1200;
const MIN_ADAPTIVE_CHUNK_CHARS = 2200;
const SAFETY_MAX_SESSION_CHUNKS = 500;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 1200;
const INTER_CHUNK_DELAY_MS = 180;
const OFFSCREEN_READY_RETRIES = 5;
const OFFSCREEN_READY_DELAY_MS = 120;
const SSE_READ_TIMEOUT_MS = 12000;
const PLAYBACK_HEARTBEAT_MS = 500;
const SPEED_STEP = 0.1;
const BASE_WORDS_PER_MINUTE = 170;
const BOOKMARKS_STORAGE_KEY = "readingBookmarks";
const MAX_BOOKMARK_POSITION_SECONDS = 60 * 60 * 4;
const BOOKMARK_RESUME_SEEK_TIMEOUT_MS = 7000;
const LOCAL_API_KEY_KEY = "secureApiKey";
const SESSION_API_KEY_KEY = "apiKey";
const MAX_CHAPTERS = 80;
const MAX_AUDIO_CACHE_BYTES = 80 * 1024 * 1024;

const DEFAULT_SETTINGS = {
  model: STREAMING_TTS_MODEL,
  voice: "marin",
  speed: 1,
  instructions:
    "Read naturally like a polished podcast narrator. Keep pacing smooth, pronunciation clear, and tone engaging without sounding theatrical."
};

const playbackState = {
  tabId: null,
  playbackId: 0,
  source: null,
  title: "",
  isPlaying: false,
  isPaused: false,
  isGenerating: false,
  pausedDuringGeneration: false,
  isComplete: false,
  queue: [],
  queueWordCounts: [],
  queueChapterIndexes: [],
  chapters: [],
  currentIndex: -1,
  totalWords: 0,
  totalChars: 0,
  pipelineState: "idle",
  deliveryMode: "sse",
  audioCache: [],
  audioCacheComplete: [],
  cacheBytesTotal: 0,
  audioTimeSeconds: 0,
  audioDurationSeconds: 0,
  currentChunkStartedAtMs: 0,
  settings: null
};

let activeFetchController = null;
let playbackHeartbeatTimer = null;
let playNextChunkRunId = 0;
const deliveryPerf = {
  sseSuccessCount: 0,
  sseFailureStreak: 0,
  avgFirstAudioMs: 0,
  sampleCount: 0
};

void initializeSecureStorage().catch(() => {});

chrome.runtime.onInstalled.addListener(async () => {
  await initializeSecureStorage();
  await rebuildContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeSecureStorage();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) {
    return;
  }

  try {
    if (info.menuItemId === CONTEXT_MENU_SPEAK_SELECTION) {
      await speakSelection(tab.id);
    }

    if (info.menuItemId === CONTEXT_MENU_SPEAK_ARTICLE) {
      await speakArticle(tab.id);
    }
  } catch (error) {
    await showToast(tab.id, error.message || "Unable to start playback.", "error");
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === playbackState.tabId) {
    await stopPlayback({ silent: true });
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (
    tabId === playbackState.tabId &&
    playbackState.isPlaying &&
    changeInfo.status === "loading"
  ) {
    await stopPlayback({ silent: true });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      const response = await handleRuntimeMessage(message, sender);
      sendResponse(response);
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "Unexpected error." });
    }
  })();

  return true;
});

async function handleRuntimeMessage(message, sender) {
  switch (message?.action) {
    case "speakSelection": {
      const tabId = await resolveTabId(message.tabId, sender);
      return await speakSelection(tabId);
    }

    case "detectArticle": {
      const tabId = await resolveTabId(message.tabId, sender);
      const article = await detectArticle(tabId);
      return { ok: true, article };
    }

    case "speakArticle": {
      const tabId = await resolveTabId(message.tabId, sender);
      return await speakArticle(tabId);
    }

    case "pausePlayback": {
      await pausePlayback();
      return { ok: true, state: getPublicPlaybackState() };
    }

    case "resumePlayback": {
      await resumePlayback();
      return { ok: true, state: getPublicPlaybackState() };
    }

    case "togglePause": {
      if (playbackState.isPaused) {
        await resumePlayback();
      } else {
        await pausePlayback();
      }
      return { ok: true, state: getPublicPlaybackState() };
    }

    case "nextChunk": {
      await skipChunk(1);
      return { ok: true, state: getPublicPlaybackState() };
    }

    case "previousChunk": {
      await skipChunk(-1);
      return { ok: true, state: getPublicPlaybackState() };
    }

    case "seekRelative": {
      const seconds = Number.isFinite(Number(message.seconds))
        ? Number(message.seconds)
        : 0;
      return await seekRelativeSeconds(seconds);
    }

    case "seekToTime": {
      const seconds = Number.isFinite(Number(message.seconds))
        ? Number(message.seconds)
        : 0;
      return await seekToAudioTime(seconds);
    }

    case "skipToChapter": {
      await skipToChapter(Number(message.chapterIndex));
      return { ok: true, state: getPublicPlaybackState() };
    }

    case "nudgeSpeed": {
      const delta = Number.isFinite(Number(message.delta))
        ? Number(message.delta)
        : SPEED_STEP;
      const nextSpeed = await nudgeSpeed(delta);
      return { ok: true, speed: nextSpeed, state: getPublicPlaybackState() };
    }

    case "saveBookmark": {
      const tabId = await resolveTabId(message.tabId, sender);
      const bookmark = await saveCurrentBookmark(tabId);
      return { ok: Boolean(bookmark), bookmark, state: getPublicPlaybackState() };
    }

    case "getBookmark": {
      const tabId = await resolveTabId(message.tabId, sender);
      const bookmark = await getBookmarkForTab(tabId);
      return { ok: true, bookmark };
    }

    case "resumeBookmark": {
      const tabId = await resolveTabId(message.tabId, sender);
      return await resumeBookmark(tabId);
    }

    case "stopPlayback": {
      await stopPlayback({ silent: Boolean(message.silent) });
      return { ok: true, state: getPublicPlaybackState() };
    }

    case "getPlaybackState": {
      return { ok: true, state: getPublicPlaybackState() };
    }

    case "getUiSettings": {
      return { ok: true, settings: await getUiSettings() };
    }

    case "audioEnded": {
      if (Number.isInteger(message.playbackId) && message.playbackId !== playbackState.playbackId) {
        return { ok: true };
      }

      if (!playbackState.isPlaying || playbackState.isPaused) {
        return { ok: true };
      }

      await playNextChunk();
      return { ok: true };
    }

    case "audioPlaying": {
      if (Number.isInteger(message.playbackId) && message.playbackId !== playbackState.playbackId) {
        return { ok: true };
      }

      if (!playbackState.isPlaying || playbackState.isPaused) {
        return { ok: true };
      }

      if (!playbackState.currentChunkStartedAtMs) {
        playbackState.currentChunkStartedAtMs = Date.now();
      }

      playbackState.isComplete = false;
      setPipelineState("playing", false);
      return { ok: true };
    }

    case "audioProgress": {
      if (Number.isInteger(message.playbackId) && message.playbackId !== playbackState.playbackId) {
        return { ok: true };
      }

      if (!playbackState.isPlaying) {
        return { ok: true };
      }

      playbackState.audioTimeSeconds = clampNumber(message.currentTime, 0, 60 * 60 * 8);
      playbackState.audioDurationSeconds = clampNumber(message.duration, 0, 60 * 60 * 8);
      if (!playbackState.currentChunkStartedAtMs) {
        playbackState.currentChunkStartedAtMs = Date.now() - playbackState.audioTimeSeconds * 1000;
      }
      broadcastPlaybackState();
      return { ok: true };
    }

    case "audioError": {
      if (Number.isInteger(message.playbackId) && message.playbackId !== playbackState.playbackId) {
        return { ok: true };
      }

      const err = message.error || "Audio playback failed.";
      await showToast(playbackState.tabId, err, "error");
      await stopPlayback({ silent: true });
      return { ok: true };
    }

    default:
      return { ok: false, error: "Unknown action." };
  }
}

async function rebuildContextMenus() {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: CONTEXT_MENU_SPEAK_SELECTION,
    title: "AuraSpeech: Speak Selection",
    contexts: ["selection"]
  });

  chrome.contextMenus.create({
    id: CONTEXT_MENU_SPEAK_ARTICLE,
    title: "AuraSpeech: Listen to Article",
    contexts: ["page"]
  });
}

async function speakSelection(tabId) {
  const response = await sendTabMessage(tabId, { action: "getSelectedText" });
  const text = (response?.selectedText || "").trim();

  if (!text) {
    await showToast(tabId, "Select text on the page first.", "warn");
    return { ok: false, error: "No selected text found." };
  }

  await startNarration({
    tabId,
    source: "selection",
    title: "Selected text",
    text
  });

  return { ok: true, state: getPublicPlaybackState() };
}

async function speakArticle(tabId) {
  const article = await detectArticle(tabId);

  if (!article.found || !article.text) {
    await showToast(tabId, "No readable article detected on this page.", "warn");
    return { ok: false, error: "No article detected." };
  }

  await startNarration({
    tabId,
    source: "article",
    title: article.title || "Article",
    text: article.text,
    chapters: article.chapters || []
  });

  return {
    ok: true,
    article: {
      title: article.title,
      wordCount: article.wordCount,
      charCount: article.charCount,
      chapterCount: (article.chapters || []).length
    },
    state: getPublicPlaybackState()
  };
}

async function detectArticle(tabId) {
  const article = await sendTabMessage(tabId, { action: "getArticle" });

  if (!article?.found) {
    return {
      found: false,
      title: "",
      wordCount: 0,
      charCount: 0,
      chapters: [],
      chapterCount: 0,
      reason: article?.reason || "No article content detected."
    };
  }

  return {
    found: true,
    title: article.title || "Article",
    text: article.text || "",
    wordCount: article.wordCount || 0,
    charCount: article.charCount || 0,
    chapters: Array.isArray(article.chapters) ? article.chapters : [],
    chapterCount: Array.isArray(article.chapters) ? article.chapters.length : 0
  };
}

async function startNarration({ tabId, source, title, text, chapters = [], startAt = null }) {
  const settings = await loadSettings();

  if (!settings.apiKey) {
    throw new Error("Set your OpenAI API key in AuraSpeech settings first.");
  }

  const cleanedText =
    Array.isArray(chapters) && chapters.length > 0
      ? normalizeText(text)
      : prepareNarrationText(text);

  if (!cleanedText) {
    throw new Error("There is no readable text to narrate.");
  }

  const adaptiveChunkLimit = getAdaptiveChunkLimit();
  const queuePlan = buildNarrationQueue({
    text: cleanedText,
    chapters,
    maxChars: adaptiveChunkLimit,
    minTargetChars: MIN_TARGET_CHUNK_CHARS
  });
  const { queue, queueWordCounts, queueChapterIndexes, chapterMeta } = queuePlan;
  const totalWords = queueWordCounts.reduce((sum, words) => sum + words, 0);
  const totalChars = queue.reduce((sum, chunk) => sum + chunk.length, 0);

  if (!queue.length) {
    throw new Error("Could not split content into playable chunks.");
  }

  if (queue.length > SAFETY_MAX_SESSION_CHUNKS) {
    throw new Error(
      `This content requires ${queue.length} API calls, which exceeds the safety ceiling of ${SAFETY_MAX_SESSION_CHUNKS} calls in one session.`
    );
  }

  await stopPlayback({ silent: true });
  const playbackId = playbackState.playbackId + 1;

  playbackState.playbackId = playbackId;
  playbackState.tabId = tabId;
  playbackState.source = source;
  playbackState.title = title;
  playbackState.isPlaying = true;
  playbackState.isPaused = false;
  playbackState.isGenerating = false;
  playbackState.pausedDuringGeneration = false;
  playbackState.isComplete = false;
  playbackState.queue = queue;
  playbackState.queueWordCounts = queueWordCounts;
  playbackState.queueChapterIndexes = queueChapterIndexes;
  playbackState.chapters = chapterMeta;
  playbackState.currentIndex = -1;
  playbackState.totalWords = totalWords;
  playbackState.totalChars = totalChars;
  playbackState.pipelineState = "extracting";
  playbackState.deliveryMode = "sse";
  playbackState.audioCache = new Array(queue.length).fill(null);
  playbackState.audioCacheComplete = new Array(queue.length).fill(false);
  playbackState.cacheBytesTotal = 0;
  playbackState.audioTimeSeconds = 0;
  playbackState.audioDurationSeconds = 0;
  playbackState.currentChunkStartedAtMs = 0;
  playbackState.settings = settings;

  const startChunkIndex = resolveStartChunkIndex(startAt, chapterMeta, queue.length);
  playbackState.currentIndex = startChunkIndex - 1;

  await sendTabMessageSafe(tabId, {
    action: "showPlayer",
    title,
    source,
    totalChunks: queue.length,
    totalWords,
    totalChars,
    chapters: chapterMeta,
    currentChapterIndex: getCurrentChapterIndex(startChunkIndex),
    pipelineState: playbackState.pipelineState,
    deliveryMode: playbackState.deliveryMode
  });

  await showToast(
    tabId,
    source === "article"
      ? `Starting article narration (${totalWords.toLocaleString()} words, ${chapterMeta.length} chapters).`
      : "Starting narration.",
    "info"
  );

  broadcastPlaybackState();
  startPlaybackHeartbeat();
  await playNextChunk();
}

async function playNextChunk() {
  if (!playbackState.isPlaying || playbackState.isPaused) {
    return;
  }

  const runId = ++playNextChunkRunId;
  const runPlaybackId = playbackState.playbackId;
  const isRunCurrent = () =>
    runId === playNextChunkRunId &&
    playbackState.playbackId === runPlaybackId &&
    playbackState.isPlaying;
  const isRunPlayable = () => isRunCurrent() && !playbackState.isPaused;
  const nextIndex = playbackState.currentIndex + 1;

  if (nextIndex >= playbackState.queue.length) {
    if (isRunCurrent()) {
      await finishPlayback();
    }
    return;
  }

  if (nextIndex > 0) {
    await sleep(INTER_CHUNK_DELAY_MS);
    if (!isRunPlayable()) {
      return;
    }
  } else if (!isRunPlayable()) {
    return;
  }

  playbackState.currentIndex = nextIndex;
  playbackState.pausedDuringGeneration = false;
  playbackState.isComplete = false;
  playbackState.audioTimeSeconds = 0;
  playbackState.audioDurationSeconds = 0;
  playbackState.currentChunkStartedAtMs = 0;
  const currentChunk = playbackState.queue[nextIndex];
  const currentChapterIndex = getCurrentChapterIndex(nextIndex);
  const cachedAudio = getCachedAudioChunk(nextIndex);

  if (cachedAudio?.length) {
    playbackState.isGenerating = false;
    setPipelineState("buffering", false, "cache");
    broadcastPlaybackState();

    await sendTabMessageSafe(playbackState.tabId, {
      action: "updatePlayer",
      currentChunk: nextIndex + 1,
      totalChunks: playbackState.queue.length,
      isPaused: false,
      isGenerating: false,
      pipelineState: playbackState.pipelineState,
      deliveryMode: playbackState.deliveryMode,
      currentChapterIndex
    });

    if (!isRunPlayable()) {
      return;
    }

    try {
      await ensureOffscreenDocument();
      if (!isRunPlayable()) {
        return;
      }
      await sendRuntimeMessageChecked({
        target: "offscreen",
        action: "playAudio",
        mimeType: "audio/mpeg",
        playbackId: runPlaybackId,
        speed: clampNumber(playbackState.settings?.speed || 1, 0.25, 4),
        audioData: Array.from(cachedAudio)
      });
    } catch (error) {
      if (!isRunCurrent()) {
        return;
      }
      await showToast(playbackState.tabId, error.message || "Failed to play cached audio.", "error");
      await stopPlayback({ silent: true });
    }
    return;
  }

  clearCachedAudioChunk(nextIndex);
  playbackState.isGenerating = true;
  const deliveryMode = chooseDeliveryMode(nextIndex, currentChunk.length);
  playbackState.deliveryMode = deliveryMode;
  setPipelineState("generating", true);
  broadcastPlaybackState();

  await sendTabMessageSafe(playbackState.tabId, {
    action: "updatePlayer",
    currentChunk: nextIndex + 1,
    totalChunks: playbackState.queue.length,
    isPaused: false,
    isGenerating: true,
    pipelineState: playbackState.pipelineState,
    deliveryMode: playbackState.deliveryMode,
    currentChapterIndex
  });

  try {
    let audioBytes = null;
    if (deliveryMode === "batch") {
      audioBytes = await playSpeechAudioNonStreaming(
        currentChunk,
        playbackState.settings,
        undefined,
        runPlaybackId,
        nextIndex
      );
    } else {
      audioBytes = await streamSpeechAudio(
        currentChunk,
        playbackState.settings,
        runPlaybackId,
        nextIndex
      );
    }

    if (!isRunCurrent()) {
      return;
    }

    cacheAudioChunk(nextIndex, audioBytes, { allowReplace: true });

    playbackState.isGenerating = false;
    if (playbackState.pipelineState === "generating") {
      setPipelineState("buffering", false);
    }
    broadcastPlaybackState();

    await sendTabMessageSafe(playbackState.tabId, {
      action: "updatePlayer",
      currentChunk: nextIndex + 1,
      totalChunks: playbackState.queue.length,
      isPaused: false,
      isGenerating: false,
      pipelineState: playbackState.pipelineState,
      deliveryMode: playbackState.deliveryMode,
      currentChapterIndex
    });
  } catch (error) {
    if (!isRunCurrent()) {
      return;
    }

    playbackState.isGenerating = false;
    broadcastPlaybackState();

    if (isAbortError(error)) {
      clearCachedAudioChunk(nextIndex);
      if (playbackState.isPaused && playbackState.currentIndex === nextIndex) {
        playbackState.currentIndex = Math.max(-1, nextIndex - 1);
        playbackState.pausedDuringGeneration = true;
        await sendRuntimeMessageSafe({
          target: "offscreen",
          action: "abortAudioStream",
          playbackId: runPlaybackId
        });
        broadcastPlaybackState();
      }
      return;
    }

    await showToast(playbackState.tabId, error.message || "Failed to generate speech.", "error");
    await stopPlayback({ silent: true });
  }
}

async function pausePlayback() {
  if (!playbackState.isPlaying || playbackState.isPaused) {
    return;
  }

  playbackState.isPaused = true;

  if (playbackState.isGenerating || playbackState.pipelineState === "buffering") {
    playbackState.pausedDuringGeneration = true;
    abortInFlightRequest();
    await sendRuntimeMessageSafe({
      target: "offscreen",
      action: "abortAudioStream",
      playbackId: playbackState.playbackId
    });
  } else {
    await sendRuntimeMessageSafe({
      target: "offscreen",
      action: "pauseAudio",
      playbackId: playbackState.playbackId
    });
  }

  await sendTabMessageSafe(playbackState.tabId, {
    action: "setPlayerPaused",
    isPaused: true
  });

  broadcastPlaybackState();
}

async function resumePlayback() {
  if (!playbackState.isPlaying || !playbackState.isPaused) {
    return;
  }

  if (playbackState.isComplete) {
    playbackState.isPaused = false;
    playbackState.isComplete = false;
    const restartIndex = playbackState.currentIndex >= 0 ? playbackState.currentIndex : 0;
    await seekToChunk(restartIndex);
    return;
  }

  if (playbackState.pausedDuringGeneration) {
    playbackState.isPaused = false;
    playbackState.pausedDuringGeneration = false;

    await sendTabMessageSafe(playbackState.tabId, {
      action: "setPlayerPaused",
      isPaused: false
    });

    broadcastPlaybackState();
    await playNextChunk();
    return;
  }

  await sendRuntimeMessageSafe({
    target: "offscreen",
    action: "resumeAudio",
    playbackId: playbackState.playbackId
  });

  playbackState.isPaused = false;
  setPipelineState("playing", false);

  await sendTabMessageSafe(playbackState.tabId, {
    action: "setPlayerPaused",
    isPaused: false
  });

  broadcastPlaybackState();

  const position = await sendRuntimeMessageSafe({
    target: "offscreen",
    action: "getAudioPosition",
    playbackId: playbackState.playbackId
  });
  const hasActiveAudio = Boolean(position?.ok) && Number(position?.duration || 0) > 0;
  if (!hasActiveAudio && playbackState.isPlaying && !playbackState.isPaused) {
    await playNextChunk();
  }
}

async function skipChunk(direction) {
  if (!playbackState.isPlaying || !playbackState.queue.length) {
    return;
  }

  const baseIndex = Math.max(0, playbackState.currentIndex);
  const targetIndex = clampInteger(
    baseIndex + (direction >= 0 ? 1 : -1),
    0,
    playbackState.queue.length - 1
  );

  await seekToChunk(targetIndex);
}

async function seekToChunk(targetIndex) {
  if (!playbackState.isPlaying || !playbackState.queue.length) {
    return;
  }

  const clampedIndex = clampInteger(targetIndex, 0, playbackState.queue.length - 1);
  const playbackId = playbackState.playbackId;

  invalidatePlayNextChunkRun();
  abortInFlightRequest();
  await sendRuntimeMessageSafe({
    target: "offscreen",
    action: "stopAudio",
    playbackId
  });

  playbackState.isPaused = false;
  playbackState.pausedDuringGeneration = false;
  playbackState.isGenerating = false;
  playbackState.isComplete = false;
  playbackState.currentIndex = clampedIndex - 1;
  playbackState.audioTimeSeconds = 0;
  playbackState.audioDurationSeconds = 0;
  playbackState.currentChunkStartedAtMs = 0;

  await sendTabMessageSafe(playbackState.tabId, {
    action: "setPlayerPaused",
    isPaused: false
  });

  broadcastPlaybackState();
  await playNextChunk();
}

async function seekRelativeSeconds(seconds) {
  if (!playbackState.isPlaying) {
    return { ok: false, error: "Nothing is currently playing." };
  }

  if (playbackState.isGenerating || playbackState.pausedDuringGeneration) {
    return { ok: false, error: "Audio is still generating. Try again in a moment." };
  }

  const deltaSeconds = clampNumber(seconds, -90, 90);
  if (Math.abs(deltaSeconds) < 0.01) {
    return { ok: false, error: "Seek amount must be non-zero." };
  }

  const response = await sendRuntimeMessageSafe({
    target: "offscreen",
    action: "seekRelativeAudio",
    playbackId: playbackState.playbackId,
    deltaSeconds
  });

  if (!response || response.ok === false) {
    return { ok: false, error: response?.error || "Could not seek current audio." };
  }

  const movedSeconds = Number(response.movedSeconds || 0);
  const requestedSeconds = Number(response.requestedSeconds || deltaSeconds);
  const hitBoundary = Boolean(response.hitBoundary);
  playbackState.audioTimeSeconds = clampNumber(response.currentTime, 0, 60 * 60 * 8);
  if (Number.isFinite(Number(response.duration))) {
    playbackState.audioDurationSeconds = clampNumber(response.duration, 0, 60 * 60 * 8);
  }
  playbackState.currentChunkStartedAtMs = Date.now() - playbackState.audioTimeSeconds * 1000;

  return {
    ok: true,
    currentTime: Number(response.currentTime || 0),
    movedSeconds,
    requestedSeconds,
    hitBoundary,
    state: getPublicPlaybackState()
  };
}

async function seekToAudioTime(seconds) {
  if (!playbackState.isPlaying) {
    return { ok: false, error: "Nothing is currently playing." };
  }

  if (playbackState.isGenerating || playbackState.pausedDuringGeneration) {
    return { ok: false, error: "Audio is still generating. Try again in a moment." };
  }

  const targetSeconds = clampNumber(seconds, 0, 60 * 60 * 8);
  const response = await sendRuntimeMessageSafe({
    target: "offscreen",
    action: "seekToAudioTime",
    playbackId: playbackState.playbackId,
    seconds: targetSeconds
  });

  if (!response || response.ok === false) {
    return { ok: false, error: response?.error || "Could not seek current audio." };
  }

  playbackState.audioTimeSeconds = clampNumber(response.currentTime, 0, 60 * 60 * 8);
  if (Number.isFinite(Number(response.duration))) {
    playbackState.audioDurationSeconds = clampNumber(response.duration, 0, 60 * 60 * 8);
  }
  playbackState.currentChunkStartedAtMs = Date.now() - playbackState.audioTimeSeconds * 1000;

  return {
    ok: true,
    currentTime: Number(response.currentTime || 0),
    duration: Number(response.duration || 0),
    hitBoundary: Boolean(response.hitBoundary),
    state: getPublicPlaybackState()
  };
}

async function seekToBookmarkPosition(positionSeconds, expectedPlaybackId = playbackState.playbackId) {
  const targetSeconds = clampNumber(positionSeconds, 0, MAX_BOOKMARK_POSITION_SECONDS);
  if (
    !playbackState.isPlaying ||
    targetSeconds <= 0 ||
    playbackState.playbackId !== expectedPlaybackId
  ) {
    return { ok: false, error: "No bookmark position to seek." };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt <= BOOKMARK_RESUME_SEEK_TIMEOUT_MS) {
    if (!playbackState.isPlaying || playbackState.playbackId !== expectedPlaybackId) {
      return { ok: false, error: "Playback stopped before bookmark seek completed." };
    }

    if (!playbackState.isGenerating && !playbackState.pausedDuringGeneration) {
      const result = await seekToAudioTime(targetSeconds);
      if (result?.ok) {
        return result;
      }

      const errorMessage = String(result?.error || "").toLowerCase();
      if (!errorMessage.includes("generating")) {
        return result || { ok: false, error: "Could not seek to bookmark position." };
      }
    }

    await sleep(120);
  }

  return { ok: false, error: "Timed out waiting for bookmark audio to become seekable." };
}

async function skipToChapter(chapterIndex) {
  if (!playbackState.isPlaying || !playbackState.chapters.length) {
    return;
  }

  const targetChapter = playbackState.chapters.find(
    (chapter) => chapter.index === clampInteger(chapterIndex, 0, playbackState.chapters.length - 1)
  );

  if (!targetChapter) {
    return;
  }

  await seekToChunk(targetChapter.startChunk);
}

async function saveCurrentBookmark(tabId) {
  if (!Number.isInteger(tabId)) {
    return null;
  }

  const bookmark = await buildBookmark(tabId);
  if (!bookmark) {
    return null;
  }

  const normalizedUrl = await getTabBookmarkUrl(tabId);
  if (normalizedUrl) {
    bookmark.pageUrl = normalizedUrl;
  }

  const storageKeys = buildBookmarkStorageKeys(tabId, normalizedUrl);
  const stored = await chrome.storage.local.get([BOOKMARKS_STORAGE_KEY]);
  const nextBookmarks = {
    ...(stored[BOOKMARKS_STORAGE_KEY] || {})
  };

  for (const key of storageKeys) {
    nextBookmarks[key] = bookmark;
  }

  await chrome.storage.local.set({ [BOOKMARKS_STORAGE_KEY]: nextBookmarks });
  return bookmark;
}

async function getBookmarkForTab(tabId) {
  if (!Number.isInteger(tabId)) {
    return null;
  }

  const normalizedUrl = await getTabBookmarkUrl(tabId);
  const storageKeys = buildBookmarkStorageKeys(tabId, normalizedUrl);
  const stored = await chrome.storage.local.get([BOOKMARKS_STORAGE_KEY]);
  const allBookmarks = stored[BOOKMARKS_STORAGE_KEY] || {};

  let matchedKey = "";
  let bookmark = null;
  for (const key of storageKeys) {
    const candidate = allBookmarks[key];
    if (!candidate) {
      continue;
    }

    if (normalizedUrl && key === buildBookmarkStorageKey(tabId)) {
      const candidateUrl = normalizeBookmarkUrl(candidate.pageUrl || "");
      if (!candidateUrl || candidateUrl !== normalizedUrl) {
        continue;
      }
    }

    matchedKey = key;
    bookmark = candidate;
    break;
  }

  if (!bookmark) {
    return null;
  }

  const preferredUrlKey = buildBookmarkUrlStorageKey(normalizedUrl);
  if (
    preferredUrlKey &&
    matchedKey !== preferredUrlKey &&
    !allBookmarks[preferredUrlKey]
  ) {
    allBookmarks[preferredUrlKey] = {
      ...bookmark,
      pageUrl: normalizedUrl
    };
    await chrome.storage.local.set({ [BOOKMARKS_STORAGE_KEY]: allBookmarks });
  }

  return bookmark;
}

async function resumeBookmark(tabId) {
  const bookmark = await getBookmarkForTab(tabId);
  if (!bookmark) {
    return { ok: false, error: "No bookmark saved for this tab." };
  }

  const resumePositionSeconds = clampNumber(
    bookmark.positionSeconds,
    0,
    MAX_BOOKMARK_POSITION_SECONDS
  );

  if (playbackState.isPlaying && playbackState.tabId === tabId) {
    await seekToChunk(bookmark.chunkIndex || 0);
    if (resumePositionSeconds > 0) {
      await seekToBookmarkPosition(resumePositionSeconds, playbackState.playbackId);
    }
    return { ok: true, resumed: true, state: getPublicPlaybackState(), bookmark };
  }

  if (bookmark.source === "selection") {
    return {
      ok: false,
      error: "Saved bookmark is from a selection. Re-select text to resume that clip."
    };
  }

  const article = await detectArticle(tabId);
  if (!article?.found || !article?.text) {
    return { ok: false, error: "Could not re-detect article for bookmark resume." };
  }

  await startNarration({
    tabId,
    source: "article",
    title: article.title || bookmark.title || "Article",
    text: article.text,
    chapters: article.chapters || [],
    startAt: {
      chapterIndex: bookmark.chapterIndex,
      chunkIndex: bookmark.chunkIndex
    }
  });
  if (resumePositionSeconds > 0) {
    await seekToBookmarkPosition(resumePositionSeconds, playbackState.playbackId);
  }

  return { ok: true, resumed: true, state: getPublicPlaybackState(), bookmark };
}

async function nudgeSpeed(delta) {
  const safeDelta = Number.isFinite(delta) ? delta : 0;
  if (safeDelta === 0) {
    return playbackState.settings?.speed || (await loadSettings()).speed;
  }

  const settings = playbackState.settings || (await loadSettings());
  const nextSpeed = roundTo(
    clampNumber(Number(settings.speed || 1) + safeDelta, 0.25, 4),
    2
  );

  settings.speed = nextSpeed;
  playbackState.settings = settings;

  await persistSpeedSetting(nextSpeed);

  if (playbackState.isPlaying) {
    await sendRuntimeMessageSafe({
      target: "offscreen",
      action: "setPlaybackRate",
      playbackId: playbackState.playbackId,
      speed: nextSpeed
    });
  }

  broadcastPlaybackState();
  return nextSpeed;
}

async function stopPlayback({ silent }) {
  invalidatePlayNextChunkRun();
  abortInFlightRequest();

  if (playbackState.isPlaying) {
    await sendRuntimeMessageSafe({
      target: "offscreen",
      action: "stopAudio",
      playbackId: playbackState.playbackId
    });
  }

  const activeTabId = playbackState.tabId;
  const hadSession = playbackState.isPlaying || playbackState.queue.length > 0;

  playbackState.tabId = null;
  playbackState.source = null;
  playbackState.title = "";
  playbackState.isPlaying = false;
  playbackState.isPaused = false;
  playbackState.isGenerating = false;
  playbackState.pausedDuringGeneration = false;
  playbackState.isComplete = false;
  playbackState.queue = [];
  playbackState.queueWordCounts = [];
  playbackState.queueChapterIndexes = [];
  playbackState.chapters = [];
  playbackState.currentIndex = -1;
  playbackState.totalWords = 0;
  playbackState.totalChars = 0;
  playbackState.pipelineState = "idle";
  playbackState.deliveryMode = "sse";
  playbackState.audioCache = [];
  playbackState.audioCacheComplete = [];
  playbackState.cacheBytesTotal = 0;
  playbackState.audioTimeSeconds = 0;
  playbackState.audioDurationSeconds = 0;
  playbackState.currentChunkStartedAtMs = 0;
  playbackState.settings = null;

  if (hadSession) {
    playbackState.playbackId += 1;
  }

  if (activeTabId) {
    await sendTabMessageSafe(activeTabId, { action: "hidePlayer" });

    if (!silent) {
      await showToast(activeTabId, "Playback stopped.", "info");
    }
  }

  broadcastPlaybackState();
  stopPlaybackHeartbeat();
}

async function finishPlayback() {
  const tabId = playbackState.tabId;
  if (!playbackState.isPlaying) {
    return;
  }

  playbackState.isGenerating = false;
  playbackState.isPaused = true;
  playbackState.pausedDuringGeneration = false;
  playbackState.isComplete = true;
  playbackState.pipelineState = "completed";
  playbackState.audioTimeSeconds = playbackState.audioDurationSeconds;

  stopPlaybackHeartbeat();
  broadcastPlaybackState();

  await sendTabMessageSafe(tabId, {
    action: "setPlayerPaused",
    isPaused: true
  });

  await showToast(tabId, "Narration finished. Cached audio is ready for replay.", "success");
}

async function streamSpeechAudio(text, settings, playbackId, chunkIndex) {
  if (playbackId !== playbackState.playbackId || !playbackState.isPlaying) {
    throw createAbortError();
  }

  const instructions = resolveSpeechInstructions(settings.instructions);
  const requestBody = {
    model: STREAMING_TTS_MODEL,
    input: text,
    voice: settings.voice,
    response_format: "mp3",
    stream_format: "sse",
    speed: clampNumber(settings.speed, 0.25, 4)
  };

  if (instructions) {
    requestBody.instructions = instructions;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (playbackId !== playbackState.playbackId || !playbackState.isPlaying) {
      throw createAbortError();
    }

    const controller = new AbortController();
    activeFetchController = controller;
    let streamStarted = false;
    const requestStartedAt = Date.now();

    try {
      const response = await fetch(OPENAI_SPEECH_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/octet-stream"
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const message =
          errorBody?.error?.message ||
          `${response.status} ${response.statusText}`;

        if (isSseUnsupportedError(response.status, message)) {
          recordSseFailure();
          return await playSpeechAudioNonStreaming(text, settings, controller.signal, playbackId);
        }

        if (shouldRetryStatus(response.status) && attempt < MAX_RETRIES) {
          const retryAfter = parseRetryAfterSeconds(response.headers.get("retry-after"));
          const delayMs = retryAfter
            ? retryAfter * 1000
            : computeBackoffMs(attempt);
          await sleep(delayMs);
          continue;
        }

        throw new Error(`OpenAI speech request failed: ${message}`);
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      await ensureOffscreenDocument();

      if (playbackId !== playbackState.playbackId || !playbackState.isPlaying) {
        throw createAbortError();
      }

      if (!contentType.includes("text/event-stream")) {
        setPipelineState("buffering", true, "batch");
        const audioData = await response.arrayBuffer();
        const audioBytes = new Uint8Array(audioData);
        await sendRuntimeMessageChecked({
          target: "offscreen",
          action: "playAudio",
          mimeType: "audio/mpeg",
          playbackId,
          speed: clampNumber(settings.speed, 0.25, 4),
          audioData: Array.from(audioBytes)
        });
        recordSseSuccess(Date.now() - requestStartedAt);
        return audioBytes;
      }

      setPipelineState("buffering", true, "sse");
      await sendRuntimeMessageChecked({
        target: "offscreen",
        action: "startAudioStream",
        playbackId,
        speed: clampNumber(settings.speed, 0.25, 4),
        mimeType: "audio/mpeg"
      });
      streamStarted = true;

      const streamMetrics = await consumeSpeechSse(response, playbackId, chunkIndex);
      const streamedBytes = streamMetrics.totalAudioBytes;

      if (streamedBytes <= 0) {
        throw new Error("Speech stream returned no audio data.");
      }

      if (playbackId !== playbackState.playbackId || !playbackState.isPlaying) {
        throw createAbortError();
      }

      await sendRuntimeMessageChecked({
        target: "offscreen",
        action: "finalizeAudioStream",
        playbackId
      });
      recordSseSuccess(streamMetrics.firstAudioMs || Date.now() - requestStartedAt);
      return streamMetrics.audioBytes;
    } catch (error) {
      if (streamStarted) {
        await sendRuntimeMessageSafe({
          target: "offscreen",
          action: "abortAudioStream",
          playbackId
        });
      }

      if (isAbortError(error)) {
        throw error;
      }

      if (isStreamPlaybackError(error) && attempt < MAX_RETRIES) {
        recordSseFailure();
        // Fallback path: ask for a normal non-SSE mp3 response and play it directly.
        return await playSpeechAudioNonStreaming(text, settings, controller.signal, playbackId);
      }

      if (attempt < MAX_RETRIES && isRetryableNetworkError(error)) {
        recordSseFailure();
        await sleep(computeBackoffMs(attempt));
        continue;
      }

      recordSseFailure();
      throw error;
    } finally {
      if (activeFetchController === controller) {
        activeFetchController = null;
      }
    }
  }

  throw new Error("OpenAI speech request failed after retries.");
}

async function consumeSpeechSse(response, playbackId, chunkIndex) {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("Speech stream body is not available.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let pendingAudioChunks = [];
  let pendingAudioLength = 0;
  let totalAudioBytes = 0;
  const capturedAudioChunks = [];
  let capturedAudioLength = 0;
  let firstAudioMs = 0;
  const startedAt = Date.now();
  let sawTerminalEvent = false;
  const seenEvents = [];
  let consecutiveReadTimeouts = 0;

  const flushAudioBatch = async () => {
    if (!pendingAudioChunks.length) {
      return;
    }

    const merged = concatUint8Arrays(pendingAudioChunks, pendingAudioLength);
    pendingAudioChunks = [];
    pendingAudioLength = 0;
    totalAudioBytes += merged.length;
    capturedAudioChunks.push(merged);
    capturedAudioLength += merged.length;
    appendAudioToCache(chunkIndex, merged);

    await sendRuntimeMessageChecked({
      target: "offscreen",
      action: "appendAudioChunk",
      playbackId,
      audioData: Array.from(merged)
    });
  };

  const processDataPayload = async (eventName, dataValue) => {
    if (!dataValue || dataValue === "[DONE]") {
      sawTerminalEvent = true;
      return;
    }

    const payload = tryParseJson(dataValue);
    const payloadType = String(payload?.type || "").toLowerCase();
    const normalizedEvent = String(eventName || "").toLowerCase();
    if (
      payloadType.endsWith(".done") ||
      payloadType === "done" ||
      normalizedEvent.endsWith(".done") ||
      normalizedEvent === "done"
    ) {
      sawTerminalEvent = true;
    }

    const seenType = payloadType || normalizedEvent || "message";
    if (seenType && seenEvents.length < 12) {
      seenEvents.push(seenType);
    }

    const audioChunks = extractSpeechAudioBase64Chunks(eventName, payload, dataValue);

    if (!audioChunks.length) {
      return;
    }

    for (const audioBase64 of audioChunks) {
      const bytes = decodeBase64ToUint8(audioBase64);
      if (!bytes?.length) {
        continue;
      }

      if (!firstAudioMs) {
        firstAudioMs = Math.max(1, Date.now() - startedAt);
      }

      pendingAudioChunks.push(bytes);
      pendingAudioLength += bytes.length;

      if (pendingAudioLength >= 16 * 1024) {
        await flushAudioBatch();
      }
    }
  };

  const processEventBlock = async (blockText) => {
    if (!blockText.trim()) {
      return;
    }

    const lines = blockText.split("\n");
    let eventName = "";
    const dataParts = [];

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":")) {
        continue;
      }

      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        dataParts.push(line.slice(5).trim());
      }
    }

    if (!dataParts.length) {
      return;
    }

    const dataValue = dataParts.join("\n");
    await processDataPayload(eventName, dataValue);
  };

  while (true) {
    const readResult = await readWithTimeout(reader, SSE_READ_TIMEOUT_MS);

    if (readResult.timedOut) {
      consecutiveReadTimeouts += 1;
      if (sawTerminalEvent || totalAudioBytes > 0) {
        if (sawTerminalEvent) {
          await reader.cancel().catch(() => {});
          break;
        }

        if (consecutiveReadTimeouts < 3) {
          continue;
        }
      }

      const stallPhase =
        totalAudioBytes > 0 ? "before stream completion" : "before audio arrived";
      throw new Error(
        `Speech SSE stream stalled ${stallPhase}. Events observed: ${
          seenEvents.join(", ") || "none"
        }`
      );
    }

    consecutiveReadTimeouts = 0;
    const { value, done } = readResult;

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");

    let eventBoundary = buffer.indexOf("\n\n");
    while (eventBoundary !== -1) {
      const eventBlock = buffer.slice(0, eventBoundary);
      buffer = buffer.slice(eventBoundary + 2);
      await processEventBlock(eventBlock);

      if (sawTerminalEvent) {
        await reader.cancel().catch(() => {});
        buffer = "";
        break;
      }

      eventBoundary = buffer.indexOf("\n\n");
    }

    if (sawTerminalEvent) {
      break;
    }
  }

  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, "\n");
  if (buffer.trim()) {
    await processEventBlock(buffer);
  }

  await flushAudioBatch();

  if (totalAudioBytes <= 0 && seenEvents.length > 0) {
    throw new Error(
      `Speech SSE stream produced no audio bytes. Events observed: ${seenEvents.join(", ")}`
    );
  }

  const audioBytes = capturedAudioChunks.length
    ? concatUint8Arrays(capturedAudioChunks, capturedAudioLength)
    : null;

  return { totalAudioBytes, firstAudioMs, audioBytes };
}

async function playSpeechAudioNonStreaming(text, settings, abortSignal, playbackId) {
  const localController = abortSignal ? null : new AbortController();
  const signal = abortSignal || localController.signal;
  if (localController) {
    activeFetchController = localController;
  }
  try {
    const instructions = resolveSpeechInstructions(settings.instructions);
    const requestBody = {
      model: STREAMING_TTS_MODEL,
      input: text,
      voice: settings.voice,
      response_format: "mp3",
      speed: clampNumber(settings.speed, 0.25, 4)
    };

    if (instructions) {
      requestBody.instructions = instructions;
    }

    const response = await fetch(OPENAI_SPEECH_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      const message =
        errorBody?.error?.message ||
        `${response.status} ${response.statusText}`;
      throw new Error(`OpenAI speech fallback failed: ${message}`);
    }

    const audioData = await response.arrayBuffer();
    const audioBytes = new Uint8Array(audioData);
    await ensureOffscreenDocument();
    setPipelineState("buffering", true, "batch");
    if (playbackId !== playbackState.playbackId || !playbackState.isPlaying || playbackState.isPaused) {
      throw createAbortError();
    }
    await sendRuntimeMessageChecked({
      target: "offscreen",
      action: "playAudio",
      mimeType: "audio/mpeg",
      playbackId,
      speed: clampNumber(settings.speed, 0.25, 4),
      audioData: Array.from(audioBytes)
    });
    return audioBytes;
  } finally {
    if (localController && activeFetchController === localController) {
      activeFetchController = null;
    }
  }
}

async function ensureOffscreenDocument() {
  if (!(await hasOffscreenDocument())) {
    await createOffscreenDocument();
  }

  await waitForOffscreenReady();
}

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("html/offscreen.html");

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });

    return contexts.length > 0;
  }

  if (chrome.offscreen.hasDocument) {
    return await chrome.offscreen.hasDocument();
  }

  return false;
}

async function createOffscreenDocument() {
  await chrome.offscreen.createDocument({
    url: "html/offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play generated speech audio for AuraSpeech"
  });
}

async function recreateOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    if (!chrome.offscreen.closeDocument) {
      return;
    }

    await chrome.offscreen.closeDocument().catch(() => {});
  }

  await createOffscreenDocument();
}

async function waitForOffscreenReady() {
  for (let attempt = 0; attempt < OFFSCREEN_READY_RETRIES; attempt += 1) {
    const response = await sendRuntimeMessageSafe({
      target: "offscreen",
      action: "ping"
    });

    if (response?.ok) {
      return;
    }

    if (attempt === 1) {
      await recreateOffscreenDocument().catch(() => {});
    }

    await sleep(OFFSCREEN_READY_DELAY_MS * (attempt + 1));
  }

  throw new Error("Offscreen audio document is not responding.");
}

async function initializeSecureStorage() {
  await lockStorageAccessLevels();
  await migrateLegacyApiKeyStorage();
}

async function lockStorageAccessLevels() {
  const tasks = [];

  if (chrome.storage?.session?.setAccessLevel) {
    tasks.push(
      chrome.storage.session
        .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
        .catch(() => {})
    );
  }

  if (chrome.storage?.local?.setAccessLevel) {
    tasks.push(
      chrome.storage.local
        .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
        .catch(() => {})
    );
  }

  await Promise.all(tasks);
}

async function migrateLegacyApiKeyStorage() {
  const [localStored, sessionStored] = await Promise.all([
    chrome.storage.local.get(["settings", "apiKey", LOCAL_API_KEY_KEY]),
    getSessionStorageSafe([SESSION_API_KEY_KEY])
  ]);

  const localSecureApiKey = normalizeApiKey(localStored?.[LOCAL_API_KEY_KEY]);
  const sessionApiKey = normalizeApiKey(sessionStored?.[SESSION_API_KEY_KEY]);
  const legacyApiKey =
    normalizeApiKey(localStored?.apiKey) ||
    normalizeApiKey(localStored?.settings?.apiKey);
  const bestApiKey = localSecureApiKey || sessionApiKey || legacyApiKey;

  const hadApiKeyInSettings = Boolean(localStored?.settings?.apiKey);
  const hadRootApiKey = Boolean(normalizeApiKey(localStored?.apiKey));
  const writes = {};

  if (!localSecureApiKey && bestApiKey) {
    writes[LOCAL_API_KEY_KEY] = bestApiKey;
  }

  if (hadApiKeyInSettings) {
    writes.settings = sanitizeSettingsForStorage(localStored?.settings || {});
  }

  if (Object.keys(writes).length) {
    await chrome.storage.local.set(writes);
  }

  if (hadRootApiKey) {
    await chrome.storage.local.remove(["apiKey"]);
  }

  if (bestApiKey) {
    await setSessionStorageSafe({ [SESSION_API_KEY_KEY]: bestApiKey });
  }
}

function sanitizeSettingsForStorage(settings) {
  const sanitized = {
    ...(settings || {})
  };

  delete sanitized.apiKey;
  return sanitized;
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

async function setSessionStorageSafe(value) {
  if (!chrome.storage?.session) {
    return false;
  }

  try {
    await chrome.storage.session.set(value);
    return true;
  } catch (_error) {
    return false;
  }
}

function normalizeApiKey(value) {
  return String(value || "").trim();
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

  const merged = {
    ...DEFAULT_SETTINGS,
    ...sanitizeSettingsForStorage(stored.settings || {})
  };

  const localSecureApiKey = normalizeApiKey(stored?.[LOCAL_API_KEY_KEY]);
  const sessionApiKey = normalizeApiKey(sessionStored?.[SESSION_API_KEY_KEY]);
  let effectiveApiKey = localSecureApiKey || sessionApiKey;
  const legacyApiKey =
    normalizeApiKey(stored.apiKey) || normalizeApiKey(stored.settings?.apiKey);

  if (!effectiveApiKey && legacyApiKey) {
    effectiveApiKey = legacyApiKey;
  }

  if (effectiveApiKey && localSecureApiKey !== effectiveApiKey) {
    await chrome.storage.local.set({ [LOCAL_API_KEY_KEY]: effectiveApiKey });
    await migrateLegacyApiKeyStorage();
  }

  if (effectiveApiKey) {
    await setSessionStorageSafe({ [SESSION_API_KEY_KEY]: effectiveApiKey });
  } else if (legacyApiKey) {
    effectiveApiKey = legacyApiKey;
  }

  merged.apiKey = effectiveApiKey;

  if (!stored.settings?.voice && stored.voice) {
    merged.voice = stored.voice;
  }

  if (!stored.settings?.speed && stored.accessibilitySettings?.speed) {
    merged.speed = stored.accessibilitySettings.speed;
  }

  merged.speed = clampNumber(merged.speed, 0.25, 4);
  merged.model = STREAMING_TTS_MODEL;
  return merged;
}

async function getUiSettings() {
  const stored = await chrome.storage.local.get([
    "settings",
    "voice",
    "accessibilitySettings"
  ]);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...sanitizeSettingsForStorage(stored.settings || {})
  };

  if (!stored.settings?.voice && stored.voice) {
    settings.voice = stored.voice;
  }

  if (!stored.settings?.speed && stored.accessibilitySettings?.speed) {
    settings.speed = stored.accessibilitySettings.speed;
  }

  return {
    voice: String(settings.voice || DEFAULT_SETTINGS.voice),
    speed: clampNumber(settings.speed, 0.25, 4),
    instructions: String(settings.instructions || ""),
    inPageControlsEnabled: true
  };
}

function getPublicPlaybackState() {
  const speed = clampNumber(playbackState.settings?.speed || 1, 0.25, 4);
  const timeline = resolveCurrentAudioTimeline(speed);
  const remainingSeconds = estimateRemainingSeconds(speed, timeline);
  const currentChapterIndex = getCurrentChapterIndex(playbackState.currentIndex);

  return {
    playbackId: playbackState.playbackId,
    isPlaying: playbackState.isPlaying,
    isPaused: playbackState.isPaused,
    isGenerating: playbackState.isGenerating,
    isComplete: playbackState.isComplete,
    source: playbackState.source,
    title: playbackState.title,
    currentChunk: playbackState.currentIndex + 1,
    totalChunks: playbackState.queue.length,
    tabId: playbackState.tabId,
    totalWords: playbackState.totalWords,
    totalChars: playbackState.totalChars,
    chapters: playbackState.chapters,
    currentChapterIndex,
    pipelineState: playbackState.pipelineState,
    deliveryMode: playbackState.deliveryMode,
    audioTimeSeconds: timeline.currentTime,
    audioDurationSeconds: timeline.duration,
    speed,
    remainingSeconds
  };
}

function estimateRemainingSeconds(speed, timeline) {
  if (playbackState.isComplete) {
    return 0;
  }

  if (!playbackState.isPlaying || !playbackState.queue.length) {
    return 0;
  }

  const maxIndex = playbackState.queue.length - 1;
  const currentIndex = clampInteger(playbackState.currentIndex, -1, maxIndex);
  let remainingSeconds = 0;

  if (currentIndex >= 0 && currentIndex <= maxIndex) {
    const currentDuration =
      clampNumber(timeline?.duration, 0, 60 * 60 * 8) ||
      estimateChunkDurationSeconds(currentIndex, speed);
    const currentTime = clampNumber(
      timeline?.currentTime,
      0,
      currentDuration > 0 ? currentDuration : 60 * 60 * 8
    );
    remainingSeconds += Math.max(0, currentDuration - currentTime);
  }

  const nextIndex = currentIndex < 0 ? 0 : currentIndex + 1;
  for (let i = nextIndex; i <= maxIndex; i += 1) {
    remainingSeconds += estimateChunkDurationSeconds(i, speed);
  }

  return remainingSeconds > 0 ? Math.max(1, Math.round(remainingSeconds)) : 0;
}

function resolveCurrentAudioTimeline(speed) {
  const currentIndex = playbackState.currentIndex;
  const maxTimelineSeconds = 60 * 60 * 8;
  let currentTime = clampNumber(playbackState.audioTimeSeconds, 0, maxTimelineSeconds);
  let duration = clampNumber(playbackState.audioDurationSeconds, 0, maxTimelineSeconds);

  if (duration <= 0) {
    duration = estimateChunkDurationSeconds(currentIndex, speed);
  }

  if (
    currentTime <= 0 &&
    playbackState.currentChunkStartedAtMs > 0 &&
    duration > 0 &&
    playbackState.isPlaying &&
    !playbackState.isPaused
  ) {
    const elapsedMs = Date.now() - playbackState.currentChunkStartedAtMs;
    currentTime = clampNumber(elapsedMs / 1000, 0, duration);
  }

  if (duration > 0) {
    currentTime = Math.min(duration, currentTime);
  }

  return { currentTime, duration };
}

function estimateChunkDurationSeconds(chunkIndex, speed) {
  if (!playbackState.isPlaying || chunkIndex < 0 || chunkIndex >= playbackState.queue.length) {
    return 0;
  }

  const wordsFromQueue = Number(playbackState.queueWordCounts?.[chunkIndex] || 0);
  const wordCount =
    wordsFromQueue > 0 ? wordsFromQueue : countWords(playbackState.queue?.[chunkIndex] || "");

  if (wordCount <= 0) {
    return 0;
  }

  const wordsPerMinute = BASE_WORDS_PER_MINUTE * clampNumber(speed, 0.25, 4);
  const seconds = (wordCount / wordsPerMinute) * 60;
  return Math.max(1, Math.round(seconds));
}

async function persistSpeedSetting(speed) {
  const stored = await chrome.storage.local.get(["settings", "accessibilitySettings"]);
  const nextSettings = {
    ...DEFAULT_SETTINGS,
    ...sanitizeSettingsForStorage(stored.settings || {}),
    speed,
    model: STREAMING_TTS_MODEL
  };

  await chrome.storage.local.set({
    settings: nextSettings,
    accessibilitySettings: {
      ...(stored.accessibilitySettings || {}),
      speed
    }
  });
}

async function resolveTabId(tabId, sender) {
  if (Number.isInteger(tabId)) {
    return tabId;
  }

  if (sender?.tab?.id) {
    return sender.tab.id;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab?.id) {
    throw new Error("No active tab found.");
  }

  return activeTab.id;
}

function broadcastPlaybackState() {
  const state = getPublicPlaybackState();
  void sendRuntimeMessageSafe({
    action: "playbackStateChanged",
    state
  });

  if (Number.isInteger(playbackState.tabId)) {
    void sendTabMessageSafe(playbackState.tabId, {
      action: "playbackStateChanged",
      state
    });
  }
}

function startPlaybackHeartbeat() {
  if (playbackHeartbeatTimer) {
    return;
  }

  playbackHeartbeatTimer = setInterval(() => {
    if (!playbackState.isPlaying) {
      stopPlaybackHeartbeat();
      return;
    }

    broadcastPlaybackState();
  }, PLAYBACK_HEARTBEAT_MS);
}

function stopPlaybackHeartbeat() {
  if (!playbackHeartbeatTimer) {
    return;
  }

  clearInterval(playbackHeartbeatTimer);
  playbackHeartbeatTimer = null;
}

function invalidatePlayNextChunkRun() {
  playNextChunkRunId += 1;
}

async function showToast(tabId, message, kind) {
  if (!tabId) {
    return;
  }

  await sendTabMessageSafe(tabId, {
    action: "showToast",
    message,
    kind
  });
}

function setPipelineState(nextState, isGenerating = playbackState.isGenerating, deliveryMode = null) {
  if (typeof nextState === "string" && nextState) {
    playbackState.pipelineState = nextState;
  }

  playbackState.isGenerating = Boolean(isGenerating);

  if (deliveryMode) {
    playbackState.deliveryMode = deliveryMode;
  }

  if (playbackState.isPlaying) {
    broadcastPlaybackState();
  }
}

function chooseDeliveryMode(chunkIndex, chunkLength) {
  if (chunkIndex <= 0) {
    return "sse";
  }

  if (deliveryPerf.sseFailureStreak >= 2) {
    return "batch";
  }

  const stableSse =
    deliveryPerf.sseSuccessCount >= 2 &&
    deliveryPerf.sseFailureStreak === 0 &&
    deliveryPerf.avgFirstAudioMs > 0 &&
    deliveryPerf.avgFirstAudioMs <= 1800;

  if (stableSse && chunkLength >= MIN_ADAPTIVE_CHUNK_CHARS) {
    return "batch";
  }

  return "sse";
}

function getCachedAudioChunk(chunkIndex) {
  if (!Array.isArray(playbackState.audioCache) || chunkIndex < 0) {
    return null;
  }

  if (Array.isArray(playbackState.audioCacheComplete)) {
    if (!playbackState.audioCacheComplete[chunkIndex]) {
      return null;
    }
  }

  const cached = playbackState.audioCache[chunkIndex];
  return cached instanceof Uint8Array && cached.length ? cached : null;
}

function appendAudioToCache(chunkIndex, audioBytes) {
  if (!Array.isArray(playbackState.audioCache)) {
    playbackState.audioCache = [];
  }

  if (!Array.isArray(playbackState.audioCacheComplete)) {
    playbackState.audioCacheComplete = [];
  }

  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return;
  }

  if (!(audioBytes instanceof Uint8Array) || !audioBytes.length) {
    return;
  }

  const existing = playbackState.audioCache[chunkIndex];
  if (existing instanceof Uint8Array && existing.length) {
    playbackState.audioCache[chunkIndex] = concatUint8Arrays(
      [existing, audioBytes],
      existing.length + audioBytes.length
    );
    playbackState.cacheBytesTotal += audioBytes.byteLength;
  } else {
    playbackState.audioCache[chunkIndex] = audioBytes;
    playbackState.cacheBytesTotal += audioBytes.byteLength;
  }

  playbackState.audioCacheComplete[chunkIndex] = false;
  pruneAudioCache(chunkIndex);
}

function clearCachedAudioChunk(chunkIndex) {
  if (!Array.isArray(playbackState.audioCache)) {
    return;
  }

  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return;
  }

  const existing = playbackState.audioCache[chunkIndex];
  if (existing instanceof Uint8Array) {
    playbackState.cacheBytesTotal -= existing.byteLength;
  }

  playbackState.audioCache[chunkIndex] = null;
  if (Array.isArray(playbackState.audioCacheComplete)) {
    playbackState.audioCacheComplete[chunkIndex] = false;
  }
  playbackState.cacheBytesTotal = Math.max(0, playbackState.cacheBytesTotal);
}

function cacheAudioChunk(chunkIndex, audioBytes, options = {}) {
  if (!Array.isArray(playbackState.audioCache)) {
    playbackState.audioCache = [];
  }

  if (!Array.isArray(playbackState.audioCacheComplete)) {
    playbackState.audioCacheComplete = [];
  }

  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return;
  }

  if (!(audioBytes instanceof Uint8Array) || !audioBytes.length) {
    return;
  }

  const allowReplace = options?.allowReplace === true;
  const markComplete = options?.markComplete !== false;
  const existing = playbackState.audioCache[chunkIndex];

  if (existing instanceof Uint8Array && !allowReplace) {
    if (markComplete) {
      playbackState.audioCacheComplete[chunkIndex] = true;
    }
    return;
  }

  if (existing instanceof Uint8Array && allowReplace) {
    playbackState.cacheBytesTotal -= existing.byteLength;
  }

  playbackState.audioCache[chunkIndex] = audioBytes;
  playbackState.cacheBytesTotal += audioBytes.byteLength;
  playbackState.audioCacheComplete[chunkIndex] = markComplete;
  pruneAudioCache(chunkIndex);
}

function pruneAudioCache(recentChunkIndex) {
  if (!Array.isArray(playbackState.audioCache)) {
    return;
  }

  if (playbackState.cacheBytesTotal <= MAX_AUDIO_CACHE_BYTES) {
    return;
  }

  const evictionCandidates = [];
  for (let i = 0; i < playbackState.audioCache.length; i += 1) {
    const entry = playbackState.audioCache[i];
    if (!(entry instanceof Uint8Array) || !entry.length) {
      continue;
    }

    if (i === recentChunkIndex) {
      continue;
    }

    evictionCandidates.push(i);
  }

  evictionCandidates.sort(
    (a, b) =>
      Math.abs(b - playbackState.currentIndex) - Math.abs(a - playbackState.currentIndex)
  );

  for (const index of evictionCandidates) {
    if (playbackState.cacheBytesTotal <= MAX_AUDIO_CACHE_BYTES) {
      break;
    }

    const entry = playbackState.audioCache[index];
    if (!(entry instanceof Uint8Array)) {
      continue;
    }

    playbackState.audioCache[index] = null;
    if (Array.isArray(playbackState.audioCacheComplete)) {
      playbackState.audioCacheComplete[index] = false;
    }
    playbackState.cacheBytesTotal -= entry.byteLength;
  }

  playbackState.cacheBytesTotal = Math.max(0, playbackState.cacheBytesTotal);
}

function getAdaptiveChunkLimit() {
  const avg = Number(deliveryPerf.avgFirstAudioMs || 0);

  if (deliveryPerf.sseFailureStreak >= 3) {
    return 2400;
  }

  if (avg >= 2600) {
    return 2600;
  }

  if (avg >= 1800) {
    return 3000;
  }

  if (deliveryPerf.sseSuccessCount >= 4 && avg > 0 && avg <= 1200) {
    return MAX_TTS_CHARS;
  }

  return 3300;
}

function buildNarrationQueue({ text, chapters, maxChars, minTargetChars }) {
  const normalizedText = normalizeText(text);
  const queue = [];
  const queueWordCounts = [];
  const queueChapterIndexes = [];
  const chapterMeta = [];

  if (!normalizedText) {
    return { queue, queueWordCounts, queueChapterIndexes, chapterMeta };
  }

  const chapterPlan = buildChapterPlan(normalizedText, chapters);

  for (const chapter of chapterPlan) {
    const sectionText = normalizeText(
      normalizedText.slice(chapter.startChar, chapter.endChar)
    );

    if (!sectionText) {
      continue;
    }

    const sectionChunks = optimizeChunks(
      chunkText(sectionText, maxChars),
      maxChars,
      minTargetChars
    );

    if (!sectionChunks.length) {
      continue;
    }

    const mappedChapterIndex = chapterMeta.length;
    const startChunk = queue.length;

    for (const sectionChunk of sectionChunks) {
      queue.push(sectionChunk);
      queueWordCounts.push(countWords(sectionChunk));
      queueChapterIndexes.push(mappedChapterIndex);
    }

    chapterMeta.push({
      index: mappedChapterIndex,
      title: chapter.title || `Chapter ${mappedChapterIndex + 1}`,
      startChar: chapter.startChar,
      endChar: chapter.endChar,
      startChunk,
      endChunk: queue.length - 1,
      wordCount: countWords(sectionText)
    });
  }

  if (!queue.length) {
    const fallbackChunks = optimizeChunks(
      chunkText(normalizedText, maxChars),
      maxChars,
      minTargetChars
    );

    for (const fallbackChunk of fallbackChunks) {
      queue.push(fallbackChunk);
      queueWordCounts.push(countWords(fallbackChunk));
      queueChapterIndexes.push(0);
    }

    if (queue.length) {
      chapterMeta.push({
        index: 0,
        title: "Chapter 1",
        startChar: 0,
        endChar: normalizedText.length,
        startChunk: 0,
        endChunk: queue.length - 1,
        wordCount: countWords(normalizedText)
      });
    }
  }

  return { queue, queueWordCounts, queueChapterIndexes, chapterMeta };
}

function buildChapterPlan(text, chapters) {
  const maxChars = text.length;

  if (!Array.isArray(chapters) || !chapters.length) {
    return [
      {
        title: "Chapter 1",
        startChar: 0,
        endChar: maxChars
      }
    ];
  }

  const normalizedChapters = chapters
    .slice(0, MAX_CHAPTERS)
    .map((chapter, index) => {
      const title = normalizeChapterTitle(chapter?.title, `Chapter ${index + 1}`);
      const startChar = clampInteger(chapter?.startChar, 0, maxChars);
      const rawEnd = Number.isFinite(Number(chapter?.endChar))
        ? clampInteger(chapter?.endChar, 0, maxChars)
        : null;

      return {
        title,
        startChar,
        endChar: rawEnd
      };
    })
    .sort((a, b) => a.startChar - b.startChar);

  const deduped = [];
  for (const chapter of normalizedChapters) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.startChar === chapter.startChar) {
      if (previous.title.startsWith("Chapter ") && !chapter.title.startsWith("Chapter ")) {
        previous.title = chapter.title;
      }
      previous.endChar = chapter.endChar || previous.endChar;
      continue;
    }

    deduped.push(chapter);
  }

  if (!deduped.length || deduped[0].startChar > 160) {
    deduped.unshift({
      title: "Intro",
      startChar: 0,
      endChar: deduped[0]?.startChar || maxChars
    });
  } else {
    deduped[0].startChar = 0;
  }

  const planned = [];
  for (let i = 0; i < deduped.length; i += 1) {
    const current = deduped[i];
    const next = deduped[i + 1];
    const inferredEnd = next ? next.startChar : maxChars;
    const endChar = clampInteger(
      Number.isFinite(current.endChar) ? current.endChar : inferredEnd,
      current.startChar,
      maxChars
    );

    if (endChar - current.startChar < 80) {
      continue;
    }

    planned.push({
      title: current.title,
      startChar: current.startChar,
      endChar
    });
  }

  if (!planned.length) {
    return [
      {
        title: deduped[0]?.title || "Chapter 1",
        startChar: 0,
        endChar: maxChars
      }
    ];
  }

  if (planned[planned.length - 1].endChar < maxChars) {
    planned[planned.length - 1].endChar = maxChars;
  }

  return planned;
}

function normalizeChapterTitle(value, fallback) {
  const normalized = normalizeText(String(value || "")).replace(/\n+/g, " ").trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.length > 90 ? `${normalized.slice(0, 87)}...` : normalized;
}

function resolveStartChunkIndex(startAt, chapterMeta, totalChunks) {
  if (!startAt || totalChunks <= 0) {
    return 0;
  }

  if (Number.isInteger(startAt.chunkIndex)) {
    return clampInteger(startAt.chunkIndex, 0, totalChunks - 1);
  }

  if (Number.isInteger(startAt.chapterIndex) && Array.isArray(chapterMeta)) {
    const targetChapter = chapterMeta.find(
      (chapter) => chapter.index === clampInteger(startAt.chapterIndex, 0, chapterMeta.length - 1)
    );

    if (targetChapter) {
      return clampInteger(targetChapter.startChunk, 0, totalChunks - 1);
    }
  }

  return 0;
}

function getCurrentChapterIndex(chunkIndex) {
  if (!playbackState.queueChapterIndexes.length || chunkIndex < 0) {
    return 0;
  }

  const safeIndex = clampInteger(chunkIndex, 0, playbackState.queueChapterIndexes.length - 1);
  const mapped = playbackState.queueChapterIndexes[safeIndex];
  return Number.isInteger(mapped) ? mapped : 0;
}

function recordSseSuccess(firstAudioMs) {
  const sample = Number(firstAudioMs || 0);
  if (sample > 0) {
    if (deliveryPerf.sampleCount === 0 || deliveryPerf.avgFirstAudioMs <= 0) {
      deliveryPerf.avgFirstAudioMs = sample;
    } else {
      deliveryPerf.avgFirstAudioMs = roundTo(
        deliveryPerf.avgFirstAudioMs * 0.7 + sample * 0.3,
        1
      );
    }

    deliveryPerf.sampleCount = Math.min(100, deliveryPerf.sampleCount + 1);
  }

  deliveryPerf.sseSuccessCount = Math.min(30, deliveryPerf.sseSuccessCount + 1);
  deliveryPerf.sseFailureStreak = 0;
}

function recordSseFailure() {
  deliveryPerf.sseFailureStreak = Math.min(8, deliveryPerf.sseFailureStreak + 1);
  deliveryPerf.sseSuccessCount = Math.max(0, deliveryPerf.sseSuccessCount - 1);
}

function buildBookmarkStorageKey(tabId) {
  return `tab:${tabId}`;
}

function buildBookmarkUrlStorageKey(normalizedUrl) {
  if (!normalizedUrl) {
    return "";
  }

  return `url:${normalizedUrl}`;
}

function buildBookmarkStorageKeys(tabId, normalizedUrl) {
  const keys = [];
  const urlKey = buildBookmarkUrlStorageKey(normalizedUrl);
  if (urlKey) {
    keys.push(urlKey);
  }

  if (Number.isInteger(tabId)) {
    keys.push(buildBookmarkStorageKey(tabId));
  }

  return keys;
}

async function getTabBookmarkUrl(tabId) {
  if (!Number.isInteger(tabId)) {
    return "";
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    return normalizeBookmarkUrl(tab?.url || "");
  } catch (_error) {
    return "";
  }
}

function normalizeBookmarkUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    if (!/^https?:$/i.test(parsed.protocol)) {
      return "";
    }

    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

async function buildBookmark(tabId) {
  if (!playbackState.isPlaying || playbackState.tabId !== tabId || playbackState.currentIndex < 0) {
    return null;
  }

  const chunkIndex = clampInteger(playbackState.currentIndex, 0, playbackState.queue.length - 1);
  const chapterIndex = getCurrentChapterIndex(chunkIndex);
  const speed = clampNumber(playbackState.settings?.speed || 1, 0.25, 4);

  const position = await sendRuntimeMessageSafe({
    target: "offscreen",
    action: "getAudioPosition",
    playbackId: playbackState.playbackId
  });
  const positionSeconds = clampNumber(position?.currentTime || 0, 0, MAX_BOOKMARK_POSITION_SECONDS);

  return {
    source: playbackState.source,
    title: playbackState.title,
    chunkIndex,
    chapterIndex,
    timestampSeconds: estimateElapsedSeconds(chunkIndex, positionSeconds, speed),
    positionSeconds,
    speed,
    savedAt: new Date().toISOString()
  };
}

function estimateElapsedSeconds(chunkIndex, chunkOffsetSeconds, speed) {
  if (!playbackState.queueWordCounts.length) {
    return Math.max(0, Math.round(chunkOffsetSeconds || 0));
  }

  let wordsBeforeChunk = 0;
  for (let i = 0; i < chunkIndex; i += 1) {
    wordsBeforeChunk += playbackState.queueWordCounts[i] || 0;
  }

  const wordsPerMinute = BASE_WORDS_PER_MINUTE * clampNumber(speed, 0.25, 4);
  const elapsedSeconds = (wordsBeforeChunk / wordsPerMinute) * 60 + Number(chunkOffsetSeconds || 0);
  return Math.max(0, Math.round(elapsedSeconds));
}

function chunkText(text, maxChars) {
  const normalized = normalizeText(text);

  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const chunks = [];
  const paragraphs = normalized.split(/\n\n+/).filter(Boolean);

  if (paragraphs.length <= 1) {
    return splitLongBlock(normalized, maxChars);
  }

  let currentChunk = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }

      chunks.push(...splitLongBlock(paragraph, maxChars));
      continue;
    }

    const next = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph;

    if (next.length > maxChars) {
      chunks.push(currentChunk.trim());
      currentChunk = paragraph;
    } else {
      currentChunk = next;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

function splitLongBlock(text, maxChars) {
  const sentenceParts = text.split(/(?<=[.!?])\s+/).filter(Boolean);

  if (sentenceParts.length <= 1) {
    return splitByWords(text, maxChars);
  }

  const chunks = [];
  let current = "";

  for (const sentence of sentenceParts) {
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }

      chunks.push(...splitByWords(sentence, maxChars));
      continue;
    }

    const next = current ? `${current} ${sentence}` : sentence;

    if (next.length > maxChars) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = next;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

function splitByWords(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;

    if (next.length > maxChars) {
      if (current) {
        chunks.push(current.trim());
      }
      current = word;
    } else {
      current = next;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

function optimizeChunks(chunks, maxChars, minTargetChars) {
  const normalizedChunks = chunks.map((chunk) => normalizeText(chunk)).filter(Boolean);

  if (normalizedChunks.length <= 1) {
    return normalizedChunks;
  }

  const compacted = [];
  let current = normalizedChunks[0];

  for (let i = 1; i < normalizedChunks.length; i += 1) {
    const next = normalizedChunks[i];
    const combined = `${current}\n\n${next}`;

    if (current.length < minTargetChars && combined.length <= maxChars) {
      current = combined;
      continue;
    }

    compacted.push(current);
    current = next;
  }

  if (current) {
    compacted.push(current);
  }

  if (compacted.length > 1) {
    const lastIndex = compacted.length - 1;
    const last = compacted[lastIndex];
    const prev = compacted[lastIndex - 1];
    const combined = `${prev}\n\n${last}`;

    if (last.length < Math.floor(minTargetChars / 2) && combined.length <= maxChars) {
      compacted[lastIndex - 1] = combined;
      compacted.pop();
    }
  }

  return compacted;
}

function prepareNarrationText(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return normalized;
  }

  const paragraphs = normalized.split(/\n\n+/).map((value) => value.trim()).filter(Boolean);
  if (paragraphs.length < 3) {
    return normalized;
  }

  const seen = new Set();
  const cleaned = [];

  for (const paragraph of paragraphs) {
    const key = paragraph.toLowerCase();
    const isLongEnoughForSafeDedup = paragraph.length >= 90;

    if (isLongEnoughForSafeDedup && seen.has(key)) {
      continue;
    }

    if (isLongEnoughForSafeDedup) {
      seen.add(key);
    }

    cleaned.push(paragraph);
  }

  return cleaned.join("\n\n");
}

function normalizeText(value) {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countWords(text) {
  if (!text.trim()) {
    return 0;
  }

  return text.trim().split(/\s+/).length;
}

function resolveSpeechInstructions(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed === DEFAULT_SETTINGS.instructions.trim()) {
    return "";
  }

  return trimmed;
}

function clampNumber(value, min, max) {
  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed)) {
    return min;
  }

  return Math.min(max, Math.max(min, parsed));
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return min;
  }

  return Math.min(max, Math.max(min, parsed));
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function tryParseJson(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function extractSpeechAudioBase64Chunks(eventName, payload, rawData) {
  const chunks = [];
  const normalizedEvent = String(eventName || "").toLowerCase();

  if (payload && typeof payload === "object") {
    const payloadType = String(payload.type || "").toLowerCase();
    const eventType = payloadType || normalizedEvent;

    if (!eventType.includes("speech.audio.done")) {
      collectAudioBase64Strings(chunks, [
        payload.audio,
        payload.delta,
        payload.audio_delta,
        payload.audio_base64,
        payload.chunk,
        payload.data?.audio,
        payload.data?.delta,
        payload.output_audio?.audio,
        payload.output_audio?.delta,
        payload.output_audio_delta
      ]);

      if (Array.isArray(payload.output)) {
        for (const outputItem of payload.output) {
          collectAudioBase64Strings(chunks, [
            outputItem?.audio,
            outputItem?.delta,
            outputItem?.audio_delta,
            outputItem?.data?.audio,
            outputItem?.data?.delta,
            outputItem?.output_audio?.audio,
            outputItem?.output_audio?.delta
          ]);
        }
      }

      if (Array.isArray(payload.audio_chunks)) {
        collectAudioBase64Strings(chunks, payload.audio_chunks);
      }

      if (typeof payload.data === "string" && eventType.includes("speech.audio.delta")) {
        collectAudioBase64Strings(chunks, [payload.data]);
      }
    }
  }

  if (!chunks.length && typeof rawData === "string") {
    if (normalizedEvent.includes("speech.audio.delta") || looksLikeBase64Audio(rawData)) {
      collectAudioBase64Strings(chunks, [rawData]);
    }
  }

  return chunks;
}

function collectAudioBase64Strings(target, values) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    target.push(trimmed);
  }
}

function decodeBase64ToUint8(base64Value) {
  try {
    let normalized = base64Value.replace(/\s+/g, "");
    normalized = normalized.replace(/-/g, "+").replace(/_/g, "/");

    const padLength = normalized.length % 4;
    if (padLength !== 0) {
      normalized += "=".repeat(4 - padLength);
    }

    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
  } catch (_error) {
    return null;
  }
}

function concatUint8Arrays(chunks, totalLength) {
  const merged = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function looksLikeBase64Audio(value) {
  if (!value || typeof value !== "string") {
    return false;
  }

  const normalized = value.replace(/\s+/g, "");
  if (normalized.length < 4) {
    return false;
  }

  return /^[A-Za-z0-9+/_=-]+$/.test(normalized);
}

function abortInFlightRequest() {
  if (activeFetchController) {
    activeFetchController.abort();
    activeFetchController = null;
  }
}

function shouldRetryStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isSseUnsupportedError(status, message) {
  if (status !== 400) {
    return false;
  }

  const normalized = String(message || "").toLowerCase();
  return normalized.includes("stream_format") || normalized.includes("sse is not supported");
}

function parseRetryAfterSeconds(value) {
  if (!value) {
    return 0;
  }

  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds;
  }

  const retryDate = Date.parse(value);
  if (!Number.isFinite(retryDate)) {
    return 0;
  }

  const deltaMs = retryDate - Date.now();
  return deltaMs > 0 ? Math.ceil(deltaMs / 1000) : 0;
}

function computeBackoffMs(attempt) {
  const jitterMs = Math.floor(Math.random() * 300);
  return BASE_RETRY_MS * 2 ** attempt + jitterMs;
}

function isRetryableNetworkError(error) {
  if (!error) {
    return false;
  }

  if (isAbortError(error)) {
    return false;
  }

  const msg = String(error.message || "").toLowerCase();
  return (
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("failed to fetch") ||
    msg.includes("load failed")
  );
}

function isAbortError(error) {
  if (!error) {
    return false;
  }

  return error.name === "AbortError" || String(error.message || "").includes("aborted");
}

function createAbortError() {
  const error = new Error("Playback request aborted.");
  error.name = "AbortError";
  return error;
}

async function readWithTimeout(reader, timeoutMs) {
  let timeoutId = null;

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  try {
    const readPromise = reader.read().then((result) => ({
      timedOut: false,
      value: result.value,
      done: result.done
    }));

    return await Promise.race([readPromise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendRuntimeMessageChecked(message) {
  const maxAttempts = message?.target === "offscreen" ? 2 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (message?.target === "offscreen") {
      await ensureOffscreenDocument();
    }

    const response = await sendRuntimeMessageSafe(message);

    if (response && response.ok !== false) {
      return response;
    }

    if (attempt < maxAttempts - 1 && message?.target === "offscreen") {
      await recreateOffscreenDocument().catch(() => {});
      continue;
    }

    if (!response) {
      throw new Error("Runtime message failed: no response.");
    }

    throw new Error(response.error || "Runtime message returned an error.");
  }

  throw new Error("Runtime message failed.");
}

function sendRuntimeMessageSafe(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve(response || null);
    });
  });
}

function isStreamPlaybackError(error) {
  if (!error) {
    return false;
  }

  if (isAbortError(error)) {
    return false;
  }

  const msg = String(error.message || "").toLowerCase();
  return (
    msg.includes("stream") ||
    msg.includes("media source") ||
    msg.includes("runtime message failed") ||
    msg.includes("no audio data") ||
    msg.includes("produced no audio bytes") ||
    msg.includes("stalled before audio arrived") ||
    msg.includes("offscreen audio document") ||
    msg.includes("unable to append audio stream chunk") ||
    msg.includes("audio stream is not active")
  );
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

async function sendTabMessageSafe(tabId, message) {
  try {
    return await sendTabMessage(tabId, message);
  } catch (_error) {
    return null;
  }
}
