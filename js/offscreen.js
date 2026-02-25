let currentAudio = null;
let currentUrl = "";
let mediaSource = null;
let sourceBuffer = null;
let appendQueue = [];
let streamFinalized = false;
let suppressEndedEvent = false;
let streamError = null;
let activePlaybackId = 0;
let lastProgressSentAt = 0;
let lastProgressSentTime = -1;
let progressTimer = null;
const SOURCE_OPEN_TIMEOUT_MS = 5000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  void (async () => {
    try {
      switch (message.action) {
        case "playAudio":
          await playAudio(
            message.audioData,
            message.mimeType || "audio/mpeg",
            message.playbackId,
            message.speed
          );
          sendResponse({ ok: true });
          break;

        case "ping":
          sendResponse({ ok: true });
          break;

        case "startAudioStream":
          await startAudioStream(
            message.mimeType || "audio/mpeg",
            message.playbackId,
            message.speed
          );
          sendResponse({ ok: true });
          break;

        case "appendAudioChunk":
          appendAudioChunk(message.audioData, message.playbackId);
          sendResponse({ ok: true });
          break;

        case "finalizeAudioStream":
          finalizeAudioStream(message.playbackId);
          sendResponse({ ok: true });
          break;

        case "abortAudioStream":
          abortAudioStream(message.playbackId);
          sendResponse({ ok: true });
          break;

        case "pauseAudio":
          pauseAudio(message.playbackId);
          sendResponse({ ok: true });
          break;

        case "resumeAudio":
          await resumeAudio(message.playbackId);
          sendResponse({ ok: true });
          break;

        case "stopAudio":
          stopAudio(message.playbackId);
          sendResponse({ ok: true });
          break;

        case "setPlaybackRate":
          setPlaybackRate(message.speed, message.playbackId);
          sendResponse({ ok: true });
          break;

        case "getAudioPosition":
          sendResponse(getAudioPosition(message.playbackId));
          break;

        case "seekRelativeAudio":
          sendResponse(seekRelativeAudio(message.deltaSeconds, message.playbackId));
          break;

        case "seekToAudioTime":
          sendResponse(seekToAudioTime(message.seconds, message.playbackId));
          break;

        default:
          sendResponse({ ok: false, error: "Unknown offscreen action." });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "Offscreen playback error." });
    }
  })();

  return true;
});

async function playAudio(audioData, mimeType, playbackId, speed) {
  stopAudio();
  const nextPlaybackId = normalizePlaybackId(playbackId, activePlaybackId + 1);
  activePlaybackId = nextPlaybackId;

  const bytes = new Uint8Array(audioData);
  const blob = new Blob([bytes], { type: mimeType });
  currentUrl = URL.createObjectURL(blob);

  currentAudio = createAudioElement(nextPlaybackId);
  startProgressTimer();
  setPlaybackRate(speed, nextPlaybackId);
  currentAudio.src = currentUrl;
  resetProgressTracking();

  await safePlay(currentAudio);
}

async function startAudioStream(mimeType, playbackId, speed) {
  stopAudio();
  const nextPlaybackId = normalizePlaybackId(playbackId, activePlaybackId + 1);
  activePlaybackId = nextPlaybackId;

  currentAudio = createAudioElement(nextPlaybackId);
  startProgressTimer();

  const targetMediaSource = new MediaSource();
  mediaSource = targetMediaSource;
  appendQueue = [];
  streamFinalized = false;
  streamError = null;

  currentUrl = URL.createObjectURL(targetMediaSource);
  currentAudio.src = currentUrl;
  resetProgressTracking();

  await waitForSourceOpen(targetMediaSource);
  if (isStalePlayback(nextPlaybackId) || mediaSource !== targetMediaSource || !currentAudio) {
    return;
  }

  const streamMimeType = resolveStreamMimeType(mimeType);

  if (!streamMimeType) {
    throw new Error(`Streaming mime type is not supported: ${mimeType}`);
  }

  sourceBuffer = targetMediaSource.addSourceBuffer(streamMimeType);
  sourceBuffer.mode = "sequence";
  sourceBuffer.addEventListener("updateend", handleSourceBufferUpdateEnd);
  setPlaybackRate(speed, nextPlaybackId);
  // Do not block stream startup on play(); chunks arrive right after this call returns.
  void safePlay(currentAudio).catch((error) => {
    if (isStalePlayback(nextPlaybackId)) {
      return;
    }

    void chrome.runtime.sendMessage({
      action: "audioError",
      playbackId: nextPlaybackId,
      error: error.message || "Browser audio playback failed to start."
    });
  });
}

function appendAudioChunk(audioData, playbackId) {
  if (isStalePlayback(playbackId)) {
    return;
  }

  throwIfStreamError();

  if (!sourceBuffer || !mediaSource) {
    throw new Error("Audio stream is not active.");
  }

  const bytes = new Uint8Array(audioData);
  appendQueue.push(bytes);
  pumpAppendQueue();

  if (currentAudio?.paused) {
    void safePlay(currentAudio).catch((error) => {
      if (isPlayInterruptionError(error)) {
        return;
      }

      if (isStalePlayback(playbackId)) {
        return;
      }

      void chrome.runtime.sendMessage({
        action: "audioError",
        playbackId,
        error: error.message || "Browser audio playback failed."
      });
    });
  }

  throwIfStreamError();
}

function finalizeAudioStream(playbackId) {
  if (isStalePlayback(playbackId)) {
    return;
  }

  throwIfStreamError();
  streamFinalized = true;
  pumpAppendQueue();
  throwIfStreamError();
}

function abortAudioStream(playbackId) {
  if (isStalePlayback(playbackId)) {
    return;
  }

  stopAudio(playbackId);
}

function pauseAudio(playbackId) {
  if (isStalePlayback(playbackId)) {
    return;
  }

  if (currentAudio && !currentAudio.paused) {
    currentAudio.pause();
  }
}

async function resumeAudio(playbackId) {
  if (isStalePlayback(playbackId)) {
    return;
  }

  if (currentAudio && currentAudio.paused) {
    await safePlay(currentAudio);
  }
}

function stopAudio(playbackId) {
  if (isStalePlayback(playbackId)) {
    return;
  }

  suppressEndedEvent = true;

  if (sourceBuffer) {
    sourceBuffer.removeEventListener("updateend", handleSourceBufferUpdateEnd);
  }

  sourceBuffer = null;
  appendQueue = [];
  streamFinalized = false;
  streamError = null;

  if (mediaSource) {
    try {
      if (mediaSource.readyState === "open") {
        mediaSource.endOfStream();
      }
    } catch (_error) {
      // no-op
    }
  }

  mediaSource = null;

  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.ontimeupdate = null;
    currentAudio.onseeked = null;
    currentAudio.onloadedmetadata = null;
    currentAudio.onplaying = null;
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }

  cleanupAudioUrl();
  activePlaybackId = 0;
  resetProgressTracking();
  stopProgressTimer();

  // Re-enable ended notifications for the next playback session.
  suppressEndedEvent = false;
}

function setPlaybackRate(speed, playbackId) {
  if (isStalePlayback(playbackId)) {
    return;
  }

  if (!currentAudio) {
    return;
  }

  const nextRate = clampRate(speed);
  currentAudio.playbackRate = nextRate;
  currentAudio.defaultPlaybackRate = nextRate;
}

function createAudioElement(playbackId) {
  const stablePlaybackId = normalizePlaybackId(playbackId, activePlaybackId);
  const audio = new Audio();

  audio.onplaying = () => {
    if (suppressEndedEvent || isStalePlayback(stablePlaybackId)) {
      return;
    }

    emitAudioProgress(true, stablePlaybackId);

    void chrome.runtime.sendMessage({
      action: "audioPlaying",
      playbackId: stablePlaybackId
    });
  };

  audio.onended = () => {
    if (suppressEndedEvent || isStalePlayback(stablePlaybackId)) {
      return;
    }

    cleanupAudioUrl();
    void chrome.runtime.sendMessage({ action: "audioEnded", playbackId: stablePlaybackId });
  };

  audio.ontimeupdate = () => {
    emitAudioProgress(false, stablePlaybackId);
  };

  audio.onloadedmetadata = () => {
    emitAudioProgress(true, stablePlaybackId);
  };

  audio.onseeked = () => {
    emitAudioProgress(true, stablePlaybackId);
  };

  audio.onerror = () => {
    if (suppressEndedEvent || isStalePlayback(stablePlaybackId)) {
      return;
    }

    cleanupAudioUrl();
    void chrome.runtime.sendMessage({
      action: "audioError",
      playbackId: stablePlaybackId,
      error: "Browser audio playback failed."
    });
  };

  return audio;
}

function getAudioPosition(playbackId) {
  if (isStalePlayback(playbackId)) {
    return { ok: false, error: "stale playback id" };
  }

  if (!currentAudio) {
    return { ok: true, currentTime: 0, duration: 0, paused: true };
  }

  return {
    ok: true,
    currentTime: Number(currentAudio.currentTime || 0),
    duration: getSeekUpperBound(currentAudio),
    paused: Boolean(currentAudio.paused)
  };
}

function seekRelativeAudio(deltaSeconds, playbackId) {
  if (isStalePlayback(playbackId)) {
    return { ok: false, error: "stale playback id" };
  }

  if (!currentAudio) {
    return { ok: false, error: "No active audio instance." };
  }

  const delta = Number.parseFloat(deltaSeconds);
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: false, error: "Invalid seek delta." };
  }

  const current = Number(currentAudio.currentTime || 0);
  const upperBound = getSeekUpperBound(currentAudio);

  let target = Math.max(0, current + delta);
  if (Number.isFinite(upperBound)) {
    target = Math.min(upperBound, target);
  }

  try {
    currentAudio.currentTime = target;
  } catch (error) {
    return { ok: false, error: error?.message || "Seek failed." };
  }

  const actual = Number(currentAudio.currentTime || target);
  const movedSeconds = actual - current;
  const epsilon = 0.05;
  const hitLowerBoundary = delta < 0 && actual <= epsilon;
  const hitUpperBoundary =
    delta > 0 &&
    Number.isFinite(upperBound) &&
    actual >= Math.max(0, upperBound - epsilon);
  const hitBoundary = hitLowerBoundary || hitUpperBoundary;

  return {
    ok: true,
    currentTime: actual,
    duration: upperBound,
    movedSeconds,
    requestedSeconds: delta,
    hitBoundary
  };
}

function seekToAudioTime(seconds, playbackId) {
  if (isStalePlayback(playbackId)) {
    return { ok: false, error: "stale playback id" };
  }

  if (!currentAudio) {
    return { ok: false, error: "No active audio instance." };
  }

  const input = Number.parseFloat(seconds);
  if (!Number.isFinite(input)) {
    return { ok: false, error: "Invalid seek time." };
  }

  const duration = getSeekUpperBound(currentAudio);
  let target = Math.max(0, input);
  if (Number.isFinite(duration)) {
    target = Math.min(duration, target);
  }

  try {
    currentAudio.currentTime = target;
  } catch (error) {
    return { ok: false, error: error?.message || "Seek failed." };
  }

  emitAudioProgress(true, playbackId);

  return {
    ok: true,
    currentTime: Number(currentAudio.currentTime || target),
    duration,
    hitBoundary: Number.isFinite(duration)
      ? target <= 0 || target >= Math.max(0, duration - 0.05)
      : target <= 0
  };
}

function resetProgressTracking() {
  lastProgressSentAt = 0;
  lastProgressSentTime = -1;
}

function emitAudioProgress(force, playbackId = activePlaybackId) {
  if (!currentAudio || suppressEndedEvent || isStalePlayback(playbackId)) {
    return;
  }

  const now = Date.now();
  const currentTime = Number(currentAudio.currentTime || 0);
  const duration = getSeekUpperBound(currentAudio);

  if (!force) {
    if (now - lastProgressSentAt < 250 && Math.abs(currentTime - lastProgressSentTime) < 0.2) {
      return;
    }
  }

  lastProgressSentAt = now;
  lastProgressSentTime = currentTime;

  void chrome.runtime.sendMessage({
    action: "audioProgress",
    playbackId,
    currentTime,
    duration
  });
}

function getSeekUpperBound(audio) {
  if (!audio) {
    return 0;
  }

  const byDuration =
    Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
  const bySeekable =
    audio.seekable && audio.seekable.length > 0
      ? audio.seekable.end(audio.seekable.length - 1)
      : null;
  const byBuffered =
    audio.buffered && audio.buffered.length > 0
      ? audio.buffered.end(audio.buffered.length - 1)
      : null;
  const byCurrentTime = Number(audio.currentTime || 0);

  if (Number.isFinite(byDuration)) {
    return byDuration;
  }

  if (Number.isFinite(bySeekable)) {
    return bySeekable;
  }

  if (Number.isFinite(byBuffered)) {
    return byBuffered;
  }

  return byCurrentTime > 0 ? byCurrentTime : 0;
}

function startProgressTimer() {
  stopProgressTimer();
  progressTimer = setInterval(() => {
    emitAudioProgress(false, activePlaybackId);
  }, 500);
}

function stopProgressTimer() {
  if (!progressTimer) {
    return;
  }

  clearInterval(progressTimer);
  progressTimer = null;
}

function handleSourceBufferUpdateEnd() {
  pumpAppendQueue();
}

function pumpAppendQueue() {
  if (!sourceBuffer || !mediaSource) {
    return;
  }

  if (streamError) {
    return;
  }

  if (sourceBuffer.updating) {
    return;
  }

  if (appendQueue.length > 0) {
    const streamPlaybackId = activePlaybackId;
    const nextChunk = appendQueue.shift();
    try {
      sourceBuffer.appendBuffer(nextChunk);
    } catch (error) {
      streamError = new Error(
        `Unable to append audio stream chunk: ${error.message || "Unknown error."}`
      );
      if (isStalePlayback(streamPlaybackId)) {
        return;
      }
      void chrome.runtime.sendMessage({
        action: "audioError",
        playbackId: streamPlaybackId,
        error: streamError.message
      });
    }
    return;
  }

  if (streamFinalized && mediaSource.readyState === "open") {
    try {
      mediaSource.endOfStream();
    } catch (_error) {
      // no-op
    }
  }
}

function resolveStreamMimeType(mimeType) {
  const candidates = [mimeType, 'audio/mpeg; codecs="mp3"', "audio/mpeg"];
  return candidates.find((candidate) => MediaSource.isTypeSupported(candidate)) || "";
}

function throwIfStreamError() {
  if (streamError) {
    throw streamError;
  }
}

async function safePlay(audio) {
  if (!audio) {
    return;
  }

  try {
    await audio.play();
  } catch (error) {
    if (isPlayInterruptionError(error)) {
      return;
    }

    throw error;
  }
}

function clampRate(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return 1;
  }

  return Math.min(4, Math.max(0.25, parsed));
}

function normalizePlaybackId(value, fallbackValue) {
  return Number.isInteger(value) ? value : fallbackValue;
}

function isStalePlayback(playbackId) {
  return Number.isInteger(playbackId) && activePlaybackId !== 0 && playbackId !== activePlaybackId;
}

function isPlayInterruptionError(error) {
  if (!error) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  const msg = String(error.message || "").toLowerCase();
  return (
    msg.includes("interrupted") ||
    msg.includes("pause()") ||
    msg.includes("new load request")
  );
}

function waitForSourceOpen(targetMediaSource) {
  return new Promise((resolve, reject) => {
    if (!targetMediaSource) {
      reject(new Error("MediaSource instance is not available."));
      return;
    }

    if (targetMediaSource.readyState === "open") {
      resolve();
      return;
    }

    if (targetMediaSource.readyState === "ended") {
      reject(new Error("MediaSource is already ended."));
      return;
    }

    let timeoutId = null;

    const handleOpen = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error("Failed to open MediaSource."));
    };

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      targetMediaSource.removeEventListener("sourceopen", handleOpen);
      targetMediaSource.removeEventListener("error", handleError);
    };

    targetMediaSource.addEventListener("sourceopen", handleOpen);
    targetMediaSource.addEventListener("error", handleError);

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for MediaSource to open."));
    }, SOURCE_OPEN_TIMEOUT_MS);
  });
}

function cleanupAudioUrl() {
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = "";
  }
}
