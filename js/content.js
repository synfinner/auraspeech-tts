(() => {
  if (window !== window.top) {
    return;
  }

  if (window.__auraspeechContentLoaded) {
    return;
  }

  window.__auraspeechContentLoaded = true;

  const MIN_ARTICLE_WORDS = 250;
  const HARD_MAX_ARTICLE_CHARS = 220000;
  const DEFAULT_IN_PAGE_CONTROLS_ENABLED = true;
  const SPEED_NUDGE = 0.1;
  const ICON_PLAY = "▶";
  const ICON_PAUSE = "⏸";
  const ICON_STOP = "⏹";

  const uiState = {
    dock: null,
    isCollapsed: true,
    controlsEnabled: DEFAULT_IN_PAGE_CONTROLS_ENABLED,
    toastRoot: null,
    playbackState: null,
    lastArticle: null,
    runtimeInvalidated: false,
    isScrubbing: false
  };

  ensureStyles();
  void initializeControls();
  document.addEventListener("selectionchange", () => {
    updateListenIntentUI();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void (async () => {
      try {
        switch (message?.action) {
          case "getSelectedText": {
            const selectedText = window.getSelection()?.toString() || "";
            sendResponse({ selectedText: selectedText.trim() });
            return;
          }

          case "getArticle": {
            sendResponse(detectArticle());
            return;
          }

          case "showToast": {
            showToast(message.message, message.kind);
            sendResponse({ ok: true });
            return;
          }

          case "showPlayer": {
            applyPlaybackState({
              isPlaying: true,
              isPaused: false,
              isGenerating: true,
              source: message.source,
              title: message.title,
              currentChunk: 0,
              totalChunks: message.totalChunks,
              totalWords: message.totalWords,
              totalChars: message.totalChars,
              chapters: Array.isArray(message.chapters) ? message.chapters : [],
              currentChapterIndex: Number(message.currentChapterIndex || 0),
              pipelineState: String(message.pipelineState || "extracting"),
              deliveryMode: String(message.deliveryMode || "sse")
            });
            setCollapsed(false);
            sendResponse({ ok: true });
            return;
          }

          case "updatePlayer": {
            applyPlaybackState({
              ...(uiState.playbackState || {}),
              isPlaying: true,
              isPaused: Boolean(message.isPaused),
              isGenerating: Boolean(message.isGenerating),
              currentChunk: Number(message.currentChunk || 0),
              totalChunks: Number(message.totalChunks || 0),
              currentChapterIndex: Number(message.currentChapterIndex || 0),
              pipelineState: String(message.pipelineState || ""),
              deliveryMode: String(message.deliveryMode || "")
            });
            sendResponse({ ok: true });
            return;
          }

          case "setPlayerPaused": {
            applyPlaybackState({
              ...(uiState.playbackState || {}),
              isPaused: Boolean(message.isPaused)
            });
            sendResponse({ ok: true });
            return;
          }

          case "hidePlayer": {
            applyPlaybackState({ isPlaying: false });
            sendResponse({ ok: true });
            return;
          }

          case "playbackStateChanged": {
            applyPlaybackState(message.state || { isPlaying: false });
            sendResponse({ ok: true });
            return;
          }

          case "settingsChanged": {
            const enabled = message.settings?.inPageControlsEnabled !== false;
            applyControlsPreference(enabled);
            sendResponse({ ok: true });
            return;
          }

          default:
            sendResponse({ ok: false, error: "Unknown action" });
        }
      } catch (error) {
        sendResponse({ ok: false, error: error.message || "Unexpected error" });
      }
    })();

    return true;
  });

  function mountDock() {
    const root = document.createElement("div");
    root.id = "auraspeech-dock";

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "auraspeech-pill";
    pill.textContent = "AuraSpeech";
    pill.addEventListener("click", () => setCollapsed(false));

    const card = document.createElement("section");
    card.className = "auraspeech-card";

    const header = document.createElement("header");
    header.className = "auraspeech-card-header";

    const heading = document.createElement("h2");
    heading.textContent = "AuraSpeech";

    const headerActions = document.createElement("div");
    headerActions.className = "auraspeech-header-actions";

    const minimize = document.createElement("button");
    minimize.type = "button";
    minimize.className = "auraspeech-icon-btn";
    minimize.textContent = "Hide";
    minimize.setAttribute("aria-label", "Hide player");
    minimize.addEventListener("click", () => setCollapsed(true));

    const close = document.createElement("button");
    close.type = "button";
    close.className = "auraspeech-icon-btn";
    close.textContent = "Close";
    close.setAttribute("aria-label", "Close player");
    close.addEventListener("click", () => setCollapsed(true));

    headerActions.append(minimize, close);
    header.append(heading, headerActions);

    const subtitle = document.createElement("p");
    subtitle.className = "auraspeech-subtitle";
    subtitle.textContent = "Ready to listen";

    const progressTrack = document.createElement("div");
    progressTrack.className = "auraspeech-progress-track";
    progressTrack.setAttribute("aria-hidden", "true");

    const progressFill = document.createElement("div");
    progressFill.className = "auraspeech-progress-fill";
    progressTrack.appendChild(progressFill);

    const progressText = document.createElement("p");
    progressText.className = "auraspeech-progress-text";
    progressText.textContent = "Select text or detect an article.";

    const stateRow = document.createElement("div");
    stateRow.className = "auraspeech-state-row";

    const pipelineChip = document.createElement("span");
    pipelineChip.className = "auraspeech-chip";
    pipelineChip.textContent = "idle";

    const deliveryChip = document.createElement("span");
    deliveryChip.className = "auraspeech-chip";
    deliveryChip.textContent = "sse";

    stateRow.append(pipelineChip, deliveryChip);

    const actionPane = document.createElement("div");
    actionPane.className = "auraspeech-mode-idle";

    const actionRow = document.createElement("div");
    actionRow.className = "auraspeech-action-row auraspeech-action-row-idle";

    const speakSelectionButton = document.createElement("button");
    speakSelectionButton.type = "button";
    speakSelectionButton.className = "auraspeech-btn secondary";
    speakSelectionButton.textContent = "Read selection";
    speakSelectionButton.addEventListener("click", async () => {
      const response = await sendRuntimeMessage({ action: "speakSelection" });
      if (!response?.ok) {
        showToast(response?.error || "Could not start selection playback.", "error");
      }
    });

    const detectArticleButton = document.createElement("button");
    detectArticleButton.type = "button";
    detectArticleButton.className = "auraspeech-btn secondary";
    detectArticleButton.textContent = "Detect article";
    detectArticleButton.addEventListener("click", () => {
      const article = detectArticle();
      uiState.lastArticle = article;
      if (article.found) {
        articleMeta.textContent = `${article.title} (${Number(article.wordCount).toLocaleString()} words, ${Number((article.chapters || []).length || 1)} chapters)`;
      } else {
        articleMeta.textContent = article.reason || "No article detected.";
      }
    });

    const listenArticleButton = document.createElement("button");
    listenArticleButton.type = "button";
    listenArticleButton.className = "auraspeech-btn primary";
    listenArticleButton.textContent = "Listen article";
    listenArticleButton.addEventListener("click", async () => {
      const hasSelection = getSelectionText().length > 0;
      const response = await sendRuntimeMessage({
        action: hasSelection ? "speakSelection" : "speakArticle"
      });
      if (!response?.ok) {
        showToast(
          response?.error ||
            (hasSelection
              ? "Could not start selection playback."
              : "Could not start article playback."),
          "error"
        );
        return;
      }

      if (response.article) {
        articleMeta.textContent = `${response.article.title} (${Number(response.article.wordCount).toLocaleString()} words, ${Number(response.article.chapterCount || 1)} chapters)`;
      }
    });

    actionRow.append(speakSelectionButton, detectArticleButton, listenArticleButton);

    const articleMeta = document.createElement("p");
    articleMeta.className = "auraspeech-meta";
    articleMeta.textContent = "Article scan not run yet.";

    actionPane.append(actionRow, articleMeta);

    const playbackPane = document.createElement("div");
    playbackPane.className = "auraspeech-mode-playing";

    const transportRow = document.createElement("div");
    transportRow.className = "auraspeech-transport-row";

    const rewindButton = document.createElement("button");
    rewindButton.type = "button";
    rewindButton.className = "auraspeech-btn secondary";
    rewindButton.textContent = "-5s";
    rewindButton.setAttribute("aria-label", "Back 5 seconds");
    rewindButton.addEventListener("click", async () => {
      const response = await sendRuntimeMessage({ action: "seekRelative", seconds: -5 });
      if (!response?.ok) {
        showToast(response?.error || "Could not seek back 5 seconds.", "error");
        return;
      }

      if (response.hitBoundary && Math.abs(Number(response.movedSeconds || 0)) < 0.1) {
        showToast("Already at the start of the current audio.", "warn");
      }
    });

    const forwardButton = document.createElement("button");
    forwardButton.type = "button";
    forwardButton.className = "auraspeech-btn secondary";
    forwardButton.textContent = "+5s";
    forwardButton.setAttribute("aria-label", "Forward 5 seconds");
    forwardButton.addEventListener("click", async () => {
      const response = await sendRuntimeMessage({ action: "seekRelative", seconds: 5 });
      if (!response?.ok) {
        showToast(response?.error || "Could not seek forward 5 seconds.", "error");
        return;
      }

      if (response.hitBoundary && Math.abs(Number(response.movedSeconds || 0)) < 0.1) {
        showToast("Already at the end of available audio.", "warn");
      }
    });

    const pauseResumeButton = document.createElement("button");
    pauseResumeButton.type = "button";
    pauseResumeButton.className = "auraspeech-btn primary auraspeech-btn-main";
    pauseResumeButton.textContent = ICON_PLAY;
    pauseResumeButton.setAttribute("aria-label", "Play");
    pauseResumeButton.title = "Play";
    pauseResumeButton.addEventListener("click", async () => {
      const response = await sendRuntimeMessage({ action: "togglePause" });
      if (!response?.ok) {
        showToast(response?.error || "Could not toggle playback.", "error");
      }
    });

    const previousChunkButton = document.createElement("button");
    previousChunkButton.type = "button";
    previousChunkButton.className = "auraspeech-btn secondary";
    previousChunkButton.textContent = "Prev chunk";
    previousChunkButton.setAttribute("aria-label", "Previous chunk");
    previousChunkButton.addEventListener("click", async () => {
      const response = await sendRuntimeMessage({ action: "previousChunk" });
      if (!response?.ok) {
        showToast(response?.error || "Could not move to previous chunk.", "error");
      }
    });

    const nextChunkButton = document.createElement("button");
    nextChunkButton.type = "button";
    nextChunkButton.className = "auraspeech-btn secondary";
    nextChunkButton.textContent = "Next chunk";
    nextChunkButton.setAttribute("aria-label", "Next chunk");
    nextChunkButton.addEventListener("click", async () => {
      const response = await sendRuntimeMessage({ action: "nextChunk" });
      if (!response?.ok) {
        showToast(response?.error || "Could not move to next chunk.", "error");
      }
    });

    const stopButton = document.createElement("button");
    stopButton.type = "button";
    stopButton.className = "auraspeech-btn danger auraspeech-btn-stop";
    stopButton.textContent = ICON_STOP;
    stopButton.setAttribute("aria-label", "Stop");
    stopButton.title = "Stop";
    stopButton.addEventListener("click", () => {
      void sendRuntimeMessage({ action: "stopPlayback" });
    });

    transportRow.append(rewindButton, pauseResumeButton, forwardButton, stopButton);

    const seekRow = document.createElement("div");
    seekRow.className = "auraspeech-seek-row";

    const elapsedLabel = document.createElement("span");
    elapsedLabel.className = "auraspeech-time-label";
    elapsedLabel.textContent = "0:00";

    const seekInput = document.createElement("input");
    seekInput.type = "range";
    seekInput.className = "auraspeech-seek-input";
    seekInput.min = "0";
    seekInput.max = "0";
    seekInput.step = "0.1";
    seekInput.value = "0";
    seekInput.disabled = true;
    seekInput.setAttribute("aria-label", "Playback position");
    seekInput.addEventListener("input", () => {
      uiState.isScrubbing = true;
      elapsedLabel.textContent = formatPlayerTime(seekInput.value);
    });
    seekInput.addEventListener("change", async () => {
      const seconds = Number.parseFloat(seekInput.value);
      uiState.isScrubbing = false;
      if (!Number.isFinite(seconds)) {
        return;
      }

      const response = await sendRuntimeMessage({ action: "seekToTime", seconds });
      if (!response?.ok) {
        showToast(response?.error || "Could not seek playback.", "error");
        return;
      }

      if (response.state) {
        applyPlaybackState(response.state);
      }
    });
    seekInput.addEventListener("pointerdown", () => {
      uiState.isScrubbing = true;
    });
    seekInput.addEventListener("pointerup", () => {
      uiState.isScrubbing = false;
    });
    seekInput.addEventListener("blur", () => {
      uiState.isScrubbing = false;
    });

    const durationLabel = document.createElement("span");
    durationLabel.className = "auraspeech-time-label";
    durationLabel.textContent = "0:00";

    seekRow.append(elapsedLabel, seekInput, durationLabel);

    const advancedPanel = document.createElement("details");
    advancedPanel.className = "auraspeech-advanced";

    const advancedSummary = document.createElement("summary");
    advancedSummary.textContent = "More controls";

    const advancedBody = document.createElement("div");
    advancedBody.className = "auraspeech-advanced-body";

    const speedRow = document.createElement("div");
    speedRow.className = "auraspeech-action-row auraspeech-action-row-two";

    const slowerButton = document.createElement("button");
    slowerButton.type = "button";
    slowerButton.className = "auraspeech-btn secondary";
    slowerButton.textContent = "- Speed";
    slowerButton.addEventListener("click", async () => {
      const response = await sendRuntimeMessage({ action: "nudgeSpeed", delta: -SPEED_NUDGE });
      if (!response?.ok) {
        showToast(response?.error || "Could not decrease speed.", "error");
        return;
      }

      if (Number.isFinite(response.speed)) {
        showToast(`Speed ${Number(response.speed).toFixed(2)}x`, "success");
      }
    });

    const fasterButton = document.createElement("button");
    fasterButton.type = "button";
    fasterButton.className = "auraspeech-btn secondary";
    fasterButton.textContent = "+ Speed";
    fasterButton.addEventListener("click", async () => {
      const response = await sendRuntimeMessage({ action: "nudgeSpeed", delta: SPEED_NUDGE });
      if (!response?.ok) {
        showToast(response?.error || "Could not increase speed.", "error");
        return;
      }

      if (Number.isFinite(response.speed)) {
        showToast(`Speed ${Number(response.speed).toFixed(2)}x`, "success");
      }
    });

    speedRow.append(slowerButton, fasterButton);

    const chunkRow = document.createElement("div");
    chunkRow.className = "auraspeech-action-row auraspeech-action-row-two";

    chunkRow.append(previousChunkButton, nextChunkButton);

    const chapterRow = document.createElement("div");
    chapterRow.className = "auraspeech-chapter-row";

    const chapterSelect = document.createElement("select");
    chapterSelect.className = "auraspeech-select";
    chapterSelect.disabled = true;
    chapterSelect.setAttribute("aria-label", "Chapter selector");

    const chapterPlaceholder = document.createElement("option");
    chapterPlaceholder.value = "-1";
    chapterPlaceholder.textContent = "No chapters";
    chapterSelect.appendChild(chapterPlaceholder);

    const jumpChapterButton = document.createElement("button");
    jumpChapterButton.type = "button";
    jumpChapterButton.className = "auraspeech-btn secondary";
    jumpChapterButton.textContent = "Jump";
    jumpChapterButton.disabled = true;
    jumpChapterButton.addEventListener("click", async () => {
      const target = Number.parseInt(chapterSelect.value, 10);
      if (!Number.isInteger(target) || target < 0) {
        return;
      }

      const response = await sendRuntimeMessage({ action: "skipToChapter", chapterIndex: target });
      if (!response?.ok) {
        showToast(response?.error || "Could not jump to chapter.", "error");
        return;
      }

      if (response.state) {
        applyPlaybackState(response.state);
      }
    });

    chapterRow.append(chapterSelect, jumpChapterButton);

    const bookmarkRow = document.createElement("div");
    bookmarkRow.className = "auraspeech-bookmark-row";

    const saveBookmarkButton = document.createElement("button");
    saveBookmarkButton.type = "button";
    saveBookmarkButton.className = "auraspeech-btn secondary";
    saveBookmarkButton.textContent = "Save bookmark";
    saveBookmarkButton.addEventListener("click", async () => {
      const response = await sendRuntimeMessage({ action: "saveBookmark" });
      if (!response?.ok || !response.bookmark) {
        showToast(response?.error || "Nothing to bookmark yet.", "warn");
        return;
      }

      if (response.state) {
        applyPlaybackState(response.state);
      }
      showToast(`Bookmark saved at ${formatDuration(response.bookmark.timestampSeconds || 0)}.`, "success");
    });

    const resumeBookmarkButton = document.createElement("button");
    resumeBookmarkButton.type = "button";
    resumeBookmarkButton.className = "auraspeech-btn secondary";
    resumeBookmarkButton.textContent = "Resume bookmark";
    resumeBookmarkButton.addEventListener("click", async () => {
      const response = await sendRuntimeMessage({ action: "resumeBookmark" });
      if (!response?.ok) {
        showToast(response?.error || "Could not resume bookmark.", "error");
        return;
      }

      if (response.state) {
        applyPlaybackState(response.state);
      }
      showToast("Resumed from bookmark.", "success");
      setCollapsed(false);
    });

    const bookmarkMeta = document.createElement("p");
    bookmarkMeta.className = "auraspeech-micro";
    bookmarkMeta.textContent = "No bookmark saved.";

    bookmarkRow.append(saveBookmarkButton, resumeBookmarkButton);
    advancedBody.append(speedRow, chunkRow, chapterRow, bookmarkRow, bookmarkMeta);
    advancedPanel.append(advancedSummary, advancedBody);

    playbackPane.append(transportRow, seekRow, advancedPanel);

    card.append(
      header,
      subtitle,
      progressTrack,
      progressText,
      stateRow,
      actionPane,
      playbackPane
    );

    root.append(pill, card);
    document.documentElement.appendChild(root);

    uiState.dock = {
      root,
      pill,
      card,
      subtitle,
      progressFill,
      progressText,
      pipelineChip,
      deliveryChip,
      actionPane,
      playbackPane,
      advancedPanel,
      pauseResumeButton,
      rewindButton,
      forwardButton,
      seekInput,
      elapsedLabel,
      durationLabel,
      previousChunkButton,
      nextChunkButton,
      slowerButton,
      fasterButton,
      chapterSelect,
      jumpChapterButton,
      saveBookmarkButton,
      resumeBookmarkButton,
      bookmarkMeta,
      listenArticleButton,
      speakSelectionButton,
      detectArticleButton,
      stopButton,
      articleMeta
    };

    setCollapsed(uiState.isCollapsed);
    renderPlaybackUI();
    updateListenIntentUI();
    applyRuntimeInvalidatedUI();
  }

  function applyPlaybackState(state) {
    const prev = uiState.playbackState || { isPlaying: false };
    const merged = {
      ...prev,
      ...(state || {})
    };

    if (!merged.isPlaying) {
      merged.isPaused = false;
      merged.isGenerating = false;
      merged.currentChunk = 0;
      merged.totalChunks = 0;
      merged.title = "";
      merged.source = "";
    }

    uiState.playbackState = merged;

    if (!uiState.dock) {
      return;
    }

    renderPlaybackUI();

    if (!prev.isPlaying && merged.isPlaying) {
      setCollapsed(false);
    }
  }

  function renderPlaybackUI() {
    const { dock, playbackState } = uiState;
    if (!dock) {
      return;
    }

    if (uiState.runtimeInvalidated) {
      applyRuntimeInvalidatedUI();
      return;
    }

    const state = playbackState || { isPlaying: false };
    dock.root.classList.toggle("is-playing", Boolean(state.isPlaying));

    if (!state.isPlaying) {
      dock.subtitle.textContent = "Ready to listen";
      dock.progressFill.style.width = "0%";
      dock.progressText.textContent = "Select text or detect an article.";
      dock.pipelineChip.textContent = "idle";
      dock.deliveryChip.textContent = "sse";
      dock.pauseResumeButton.textContent = ICON_PLAY;
      dock.pauseResumeButton.setAttribute("aria-label", "Play");
      dock.pauseResumeButton.title = "Play";
      dock.pauseResumeButton.disabled = true;
      dock.pauseResumeButton.classList.remove("is-live");
      dock.rewindButton.disabled = true;
      dock.forwardButton.disabled = true;
      dock.seekInput.disabled = true;
      dock.seekInput.max = "0";
      dock.seekInput.value = "0";
      dock.elapsedLabel.textContent = "0:00";
      dock.durationLabel.textContent = "0:00";
      dock.previousChunkButton.disabled = true;
      dock.nextChunkButton.disabled = true;
      dock.stopButton.disabled = true;
      dock.slowerButton.disabled = true;
      dock.fasterButton.disabled = true;
      dock.chapterSelect.disabled = true;
      dock.jumpChapterButton.disabled = true;
      dock.saveBookmarkButton.disabled = true;
      dock.resumeBookmarkButton.disabled = false;
      dock.advancedPanel.open = false;
      dock.pill.textContent = "AuraSpeech";
      dock.bookmarkMeta.textContent = "No active playback.";
      refreshChapterOptions([]);
      updateListenIntentUI();
      return;
    }

    const title = state.title || (state.source === "article" ? "Article" : "Selection");
    const current = Number(state.currentChunk || 0);
    const total = Math.max(1, Number(state.totalChunks || 1));
    const percent = Math.round((current / total) * 100);
    const speed = Number(state.speed || 1).toFixed(2);
    const chapterCount = Math.max(1, Number((state.chapters || []).length || 1));

    let modeLabel = "Playing";
    if (state.isComplete) {
      modeLabel = "Finished";
    } else if (state.isPaused) {
      modeLabel = "Paused";
    } else if (state.pipelineState === "buffering") {
      modeLabel = "Buffering";
    } else if (state.pipelineState === "extracting") {
      modeLabel = "Extracting";
    } else if (state.isGenerating) {
      modeLabel = "Generating";
    }
    const pipelineState = String(state.pipelineState || modeLabel.toLowerCase());
    const deliveryMode = String(state.deliveryMode || "sse");
    const currentChapterIndex = Number.isInteger(state.currentChapterIndex)
      ? state.currentChapterIndex
      : 0;
    const seekDisabled =
      state.isGenerating || pipelineState === "extracting" || pipelineState === "buffering";
    const currentAudioTime = clampUiNumber(state.audioTimeSeconds, 0, 60 * 60 * 8);
    const currentAudioDuration = clampUiNumber(state.audioDurationSeconds, 0, 60 * 60 * 8);
    const remainingEstimate = clampUiNumber(state.remainingSeconds, 0, 60 * 60 * 8);
    const effectiveAudioDuration = Math.max(
      currentAudioDuration,
      currentAudioTime,
      currentAudioTime + remainingEstimate
    );
    const effectiveRemaining = Math.max(
      0,
      remainingEstimate,
      effectiveAudioDuration - currentAudioTime
    );

    dock.subtitle.textContent = `${title}`;
    dock.progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    dock.progressText.textContent = `${modeLabel} · ${deliveryMode.toUpperCase()} · Chapter ${currentChapterIndex + 1}/${chapterCount} · ${speed}x · ${formatDuration(effectiveRemaining)} left`;
    dock.pipelineChip.textContent = pipelineState;
    dock.deliveryChip.textContent = deliveryMode.toUpperCase();
    dock.pauseResumeButton.disabled = false;
    dock.pauseResumeButton.classList.toggle(
      "is-live",
      !state.isPaused && !state.isGenerating && pipelineState === "playing"
    );
    dock.rewindButton.disabled = seekDisabled;
    dock.forwardButton.disabled = seekDisabled;
    dock.seekInput.disabled = seekDisabled || effectiveAudioDuration <= 0;
    if (!uiState.isScrubbing) {
      dock.seekInput.max = String(effectiveAudioDuration > 0 ? effectiveAudioDuration : 0);
      dock.seekInput.value = String(
        Math.min(effectiveAudioDuration > 0 ? effectiveAudioDuration : 0, currentAudioTime)
      );
      dock.elapsedLabel.textContent = formatPlayerTime(currentAudioTime);
    }
    dock.durationLabel.textContent = formatPlayerTime(effectiveAudioDuration);
    dock.previousChunkButton.disabled = current <= 1;
    dock.nextChunkButton.disabled = current >= total;
    dock.stopButton.disabled = false;
    dock.slowerButton.disabled = false;
    dock.fasterButton.disabled = false;
    dock.saveBookmarkButton.disabled = current <= 0;
    dock.resumeBookmarkButton.disabled = false;
    const pauseResumeVisual = state.isPaused || state.isComplete ? ICON_PLAY : ICON_PAUSE;
    const pauseResumeLabel = state.isComplete
      ? "Replay"
      : state.isPaused
        ? "Resume"
        : "Pause";
    dock.pauseResumeButton.textContent = pauseResumeVisual;
    dock.pauseResumeButton.setAttribute("aria-label", pauseResumeLabel);
    dock.pauseResumeButton.title = pauseResumeLabel;
    dock.stopButton.setAttribute("aria-label", "Stop");
    dock.stopButton.title = "Stop";
    dock.pill.textContent = state.isComplete
      ? "AuraSpeech (finished)"
      : state.isPaused
        ? "AuraSpeech (paused)"
        : "AuraSpeech (playing)";
    refreshChapterOptions(state.chapters || [], currentChapterIndex);
    dock.bookmarkMeta.textContent = `Chunk ${current}/${total} · Chapter ${currentChapterIndex + 1}/${chapterCount}`;
  }

  function refreshChapterOptions(chapters, selectedIndex = 0) {
    if (!uiState.dock?.chapterSelect) {
      return;
    }

    const select = uiState.dock.chapterSelect;
    const safeChapters = Array.isArray(chapters) ? chapters : [];
    select.innerHTML = "";

    if (!safeChapters.length) {
      const emptyOption = document.createElement("option");
      emptyOption.value = "-1";
      emptyOption.textContent = "No chapters";
      select.appendChild(emptyOption);
      select.disabled = true;
      if (uiState.dock.jumpChapterButton) {
        uiState.dock.jumpChapterButton.disabled = true;
      }
      return;
    }

    for (const chapter of safeChapters) {
      const option = document.createElement("option");
      option.value = String(chapter.index);
      option.textContent = formatChapterLabel(chapter);
      select.appendChild(option);
    }

    const safeSelected = Math.min(
      safeChapters.length - 1,
      Math.max(0, Number(selectedIndex || 0))
    );
    select.value = String(safeSelected);
    select.disabled = false;
    if (uiState.dock.jumpChapterButton) {
      uiState.dock.jumpChapterButton.disabled = false;
    }
  }

  function formatChapterLabel(chapter) {
    const title = String(chapter?.title || "").trim() || `Chapter ${Number(chapter?.index || 0) + 1}`;
    const words = Number(chapter?.wordCount || 0);
    const suffix = words > 0 ? ` (${words.toLocaleString()}w)` : "";
    return `${title}${suffix}`;
  }

  function updateListenIntentUI() {
    if (!uiState.dock) {
      return;
    }

    const hasSelection = getSelectionText().length > 0;
    uiState.dock.listenArticleButton.textContent = hasSelection
      ? "Listen selection"
      : "Listen article";
  }

  function setCollapsed(collapsed) {
    uiState.isCollapsed = collapsed;
    if (!uiState.dock) {
      return;
    }

    uiState.dock.root.classList.toggle("is-collapsed", collapsed);
  }

  async function hydratePlaybackState() {
    const response = await sendRuntimeMessage({ action: "getPlaybackState" });
    if (response?.ok) {
      applyPlaybackState(response.state || { isPlaying: false });
    }
  }

  async function initializeControls() {
    let enabled = DEFAULT_IN_PAGE_CONTROLS_ENABLED;

    if (!uiState.runtimeInvalidated) {
      const response = await sendRuntimeMessage({ action: "getUiSettings" });
      if (response?.ok && response.settings) {
        enabled = response.settings.inPageControlsEnabled !== false;
      }
    }

    applyControlsPreference(enabled);
    await hydratePlaybackState();
  }

  function applyControlsPreference(enabled) {
    uiState.controlsEnabled = enabled;

    if (!enabled) {
      unmountDock();
      return;
    }

    if (!uiState.dock) {
      mountDock();
    } else {
      renderPlaybackUI();
    }
  }

  function unmountDock() {
    if (uiState.dock?.root) {
      uiState.dock.root.remove();
    }

    uiState.dock = null;
  }

  function showToast(message, kind = "info") {
    if (!message) {
      return;
    }

    if (!uiState.toastRoot) {
      const root = document.createElement("div");
      root.id = "auraspeech-toast-root";
      document.documentElement.appendChild(root);
      uiState.toastRoot = root;
    }

    const toast = document.createElement("div");
    toast.className = `auraspeech-toast auraspeech-toast-${kind}`;
    toast.textContent = message;
    uiState.toastRoot.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add("is-visible");
    });

    setTimeout(() => {
      toast.classList.remove("is-visible");
      setTimeout(() => toast.remove(), 220);
    }, 2400);
  }

  function ensureStyles() {
    if (document.getElementById("auraspeech-styles")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "auraspeech-styles";
    style.textContent = `
      #auraspeech-dock {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        font-family: "Avenir Next", "SF Pro Text", "Segoe UI", sans-serif;
      }

      .auraspeech-pill {
        border: 1px solid rgba(148, 163, 184, 0.36);
        background: linear-gradient(160deg, rgba(15, 23, 42, 0.95) 0%, rgba(30, 41, 59, 0.92) 100%);
        color: #e6edf8;
        border-radius: 12px;
        padding: 10px 14px;
        font-size: 12px;
        font-weight: 650;
        letter-spacing: 0.02em;
        cursor: pointer;
        box-shadow: 0 16px 30px rgba(2, 6, 23, 0.42);
        transition: transform 140ms ease, box-shadow 180ms ease;
      }

      .auraspeech-pill:hover {
        transform: translateY(-1px);
        box-shadow: 0 18px 34px rgba(2, 6, 23, 0.5);
      }

      .auraspeech-card {
        width: min(92vw, 360px);
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 14px;
        background:
          radial-gradient(90% 120% at 100% -20%, rgba(56, 189, 248, 0.18) 0%, rgba(56, 189, 248, 0) 60%),
          linear-gradient(160deg, rgba(15, 23, 42, 0.96) 0%, rgba(20, 33, 49, 0.95) 100%);
        color: #e2e8f0;
        box-shadow: 0 22px 44px rgba(2, 6, 23, 0.5);
        backdrop-filter: blur(14px);
        padding: 14px;
      }

      #auraspeech-dock.is-collapsed .auraspeech-card {
        display: none;
      }

      #auraspeech-dock:not(.is-collapsed) .auraspeech-pill {
        display: none;
      }

      .auraspeech-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
      }

      .auraspeech-card-header h2 {
        margin: 0;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: none;
        color: #c8dbf8;
      }

      .auraspeech-header-actions {
        display: flex;
        gap: 8px;
      }

      .auraspeech-icon-btn {
        border: 1px solid rgba(148, 163, 184, 0.34);
        background: rgba(30, 41, 59, 0.8);
        color: #f8fafc;
        border-radius: 7px;
        padding: 7px 10px;
        min-height: 34px;
        font-size: 12px;
        line-height: 1;
        font-weight: 600;
        cursor: pointer;
        transition: transform 120ms ease, background-color 120ms ease;
      }

      .auraspeech-icon-btn:hover {
        transform: translateY(-1px);
        background: rgba(51, 65, 85, 0.95);
      }

      .auraspeech-subtitle {
        margin: 0;
        font-size: 15px;
        color: #f8fafc;
        font-weight: 700;
      }

      .auraspeech-progress-track {
        margin-top: 10px;
        height: 6px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.2);
        overflow: hidden;
      }

      .auraspeech-progress-fill {
        width: 0%;
        height: 100%;
        background: linear-gradient(90deg, #22d3ee 0%, #34d399 100%);
        transition: width 260ms ease;
      }

      .auraspeech-progress-text {
        margin: 10px 0 0;
        font-size: 12px;
        color: #d0dae8;
        min-height: 17px;
      }

      .auraspeech-state-row {
        margin-top: 10px;
        display: flex;
        gap: 6px;
      }

      .auraspeech-chip {
        display: inline-flex;
        align-items: center;
        border-radius: 8px;
        padding: 4px 9px;
        font-size: 10px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        background: rgba(15, 23, 42, 0.62);
        border: 1px solid rgba(148, 163, 184, 0.32);
        color: #d4e0f5;
        font-weight: 650;
      }

      .auraspeech-mode-idle,
      .auraspeech-mode-playing {
        margin-top: 12px;
      }

      .auraspeech-mode-idle {
        display: grid;
        gap: 10px;
      }

      .auraspeech-mode-playing {
        display: none;
        gap: 10px;
      }

      #auraspeech-dock.is-playing .auraspeech-mode-idle {
        display: none;
      }

      #auraspeech-dock.is-playing .auraspeech-mode-playing {
        display: grid;
      }

      .auraspeech-action-row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
      }

      .auraspeech-action-row-two {
        grid-template-columns: 1fr 1fr;
      }

      .auraspeech-transport-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1fr) auto;
        gap: 8px;
      }

      .auraspeech-seek-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;
      }

      .auraspeech-time-label {
        font-size: 11px;
        color: #bcd0ea;
        min-width: 38px;
        text-align: center;
      }

      .auraspeech-seek-input {
        width: 100%;
        accent-color: #22d3ee;
      }

      .auraspeech-chapter-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
      }

      .auraspeech-bookmark-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      .auraspeech-advanced {
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 9px;
        background: rgba(15, 23, 42, 0.35);
        overflow: hidden;
      }

      .auraspeech-advanced summary {
        list-style: none;
        cursor: pointer;
        padding: 10px 12px;
        font-size: 12px;
        font-weight: 650;
        color: #d4e0f5;
        user-select: none;
      }

      .auraspeech-advanced summary::-webkit-details-marker {
        display: none;
      }

      .auraspeech-advanced-body {
        padding: 0 10px 10px;
        display: grid;
        gap: 8px;
      }

      .auraspeech-select {
        width: 100%;
        border: 1px solid rgba(148, 163, 184, 0.32);
        background: rgba(30, 41, 59, 0.84);
        color: #e2e8f0;
        border-radius: 8px;
        padding: 10px;
        font-size: 12px;
        min-height: 44px;
      }

      .auraspeech-btn {
        border: none;
        border-radius: 9px;
        min-height: 44px;
        padding: 10px;
        font-size: 12px;
        font-weight: 650;
        cursor: pointer;
        transition: transform 100ms ease, filter 130ms ease, box-shadow 130ms ease;
        box-shadow: 0 6px 14px rgba(2, 6, 23, 0.2);
      }

      .auraspeech-btn:disabled {
        opacity: 0.58;
        cursor: not-allowed;
        box-shadow: none;
      }

      .auraspeech-btn:not(:disabled):hover {
        transform: translateY(-1px);
        filter: saturate(1.05);
      }

      .auraspeech-btn:not(:disabled):active {
        transform: translateY(0) scale(0.97);
      }

      .auraspeech-btn.is-live {
        animation: auraspeech-live-pulse 1.1s ease-in-out infinite;
      }

      .auraspeech-btn.primary {
        background: linear-gradient(160deg, #14b8a6 0%, #0f766e 100%);
        color: #fff;
      }

      .auraspeech-btn.secondary {
        background: #334155;
        color: #e8eef8;
      }

      .auraspeech-btn.danger {
        background: #ef4444;
        color: #fff;
      }

      .auraspeech-btn-main {
        font-size: 14px;
      }

      .auraspeech-btn-stop {
        min-width: 68px;
      }

      .auraspeech-meta {
        margin: 0;
        font-size: 11px;
        color: #9cc8ff;
      }

      .auraspeech-micro {
        margin: 0;
        font-size: 11px;
        color: #9ab2d4;
      }

      #auraspeech-toast-root {
        position: fixed;
        bottom: 18px;
        left: 18px;
        z-index: 2147483647;
        display: grid;
        gap: 8px;
        pointer-events: none;
      }

      .auraspeech-toast {
        max-width: 320px;
        background: #0f172a;
        color: #f8fafc;
        border-radius: 8px;
        border: 1px solid #1e293b;
        padding: 10px 12px;
        font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 160ms ease, transform 160ms ease;
      }

      .auraspeech-toast.is-visible {
        opacity: 1;
        transform: translateY(0);
      }

      .auraspeech-icon-btn:focus-visible,
      .auraspeech-btn:focus-visible,
      .auraspeech-select:focus-visible,
      .auraspeech-pill:focus-visible,
      .auraspeech-advanced summary:focus-visible {
        outline: 2px solid rgba(56, 189, 248, 0.8);
        outline-offset: 2px;
      }

      @media (max-width: 480px) {
        #auraspeech-dock {
          right: 10px;
          left: 10px;
          bottom: 10px;
        }

        .auraspeech-card {
          width: 100%;
          padding: 12px;
        }

        .auraspeech-action-row,
        .auraspeech-bookmark-row {
          grid-template-columns: 1fr;
        }

        .auraspeech-transport-row {
          grid-template-columns: 1fr 1fr;
        }

        .auraspeech-btn-stop {
          grid-column: 1 / -1;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .auraspeech-pill,
        .auraspeech-btn,
        .auraspeech-icon-btn,
        .auraspeech-progress-fill,
        .auraspeech-toast {
          transition: none !important;
          animation: none !important;
        }
      }

      @keyframes auraspeech-live-pulse {
        0% {
          box-shadow: 0 6px 14px rgba(2, 6, 23, 0.2);
        }
        50% {
          box-shadow: 0 10px 20px rgba(34, 211, 238, 0.35);
        }
        100% {
          box-shadow: 0 6px 14px rgba(2, 6, 23, 0.2);
        }
      }

      .auraspeech-toast-success { border-color: #166534; }
      .auraspeech-toast-error { border-color: #b91c1c; }
      .auraspeech-toast-warn { border-color: #92400e; }
    `;

    document.documentElement.appendChild(style);
  }

  function detectArticle() {
    const candidates = collectCandidates();
    let best = null;

    for (const element of candidates) {
      const result = scoreCandidate(element);
      if (!result) {
        continue;
      }

      if (!best || result.score > best.score) {
        best = result;
      }
    }

    if (!best) {
      const fallback = fallbackFromParagraphs();
      if (!fallback) {
        return {
          found: false,
          reason: "No sufficiently long article-like content found."
        };
      }
      best = fallback;
    }

    let text = best.text;

    if (text.length > HARD_MAX_ARTICLE_CHARS) {
      text = text.slice(0, HARD_MAX_ARTICLE_CHARS);
      const periodIndex = text.lastIndexOf(".");
      if (periodIndex > 0) {
        text = text.slice(0, periodIndex + 1);
      }
    }

    const normalized = normalizeText(text);
    const wordCount = countWords(normalized);

    if (wordCount < MIN_ARTICLE_WORDS) {
      return {
        found: false,
        reason: "Detected content is too short to be treated as an article."
      };
    }

    const title = pickArticleTitle(best.element);
    const chapters = extractChapters(best.element, normalized, title);

    return {
      found: true,
      title,
      text: normalized,
      wordCount,
      charCount: normalized.length,
      chapters
    };
  }

  function collectCandidates() {
    const selectors = [
      "article",
      "main article",
      "main",
      "[role='main']",
      ".article-content",
      ".post-content",
      ".entry-content",
      ".story-body",
      ".article-body",
      "#article-body"
    ];

    const set = new Set();
    const elements = [];

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => {
        if (!(node instanceof HTMLElement)) {
          return;
        }

        if (set.has(node)) {
          return;
        }

        set.add(node);
        elements.push(node);
      });
    }

    return elements;
  }

  function scoreCandidate(element) {
    const text = extractReadableText(element);
    const wordCount = countWords(text);

    if (wordCount < MIN_ARTICLE_WORDS) {
      return null;
    }

    const paragraphCount = element.querySelectorAll("p").length;
    const headingCount = element.querySelectorAll("h1, h2").length;
    const linkTextLength = Array.from(element.querySelectorAll("a"))
      .map((a) => a.textContent || "")
      .join(" ")
      .length;
    const linkDensity = linkTextLength / Math.max(text.length, 1);

    const score =
      text.length +
      paragraphCount * 140 +
      headingCount * 120 -
      linkDensity * 1500;

    return { element, text, score };
  }

  function fallbackFromParagraphs() {
    const paragraphs = Array.from(document.querySelectorAll("p"))
      .map((p) => normalizeText(p.textContent || ""))
      .filter((text) => text.length > 80);

    if (paragraphs.length < 4) {
      return null;
    }

    return {
      element: document.body,
      text: paragraphs.join("\n\n"),
      score: paragraphs.join(" ").length
    };
  }

  function pickArticleTitle(element) {
    const heading =
      element?.querySelector?.("h1")?.textContent?.trim() ||
      document.querySelector("main h1, article h1, h1")?.textContent?.trim();

    return heading || document.title || "Article";
  }

  function extractChapters(element, normalizedText, fallbackTitle) {
    if (!normalizedText) {
      return [];
    }

    const headingNodes = Array.from(
      element?.querySelectorAll?.("h1, h2, h3, h4") || []
    ).slice(0, 80);
    const headingTexts = [];
    const seen = new Set();

    for (const heading of headingNodes) {
      const headingText = normalizeText(heading.textContent || "").replace(/\n+/g, " ").trim();
      if (!headingText || headingText.length < 3) {
        continue;
      }

      const key = headingText.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      headingTexts.push(headingText);
    }

    if (!headingTexts.length) {
      return [
        {
          index: 0,
          title: fallbackTitle || "Article",
          startChar: 0,
          endChar: normalizedText.length,
          wordCount: countWords(normalizedText)
        }
      ];
    }

    const markers = [];
    let cursor = 0;

    for (const heading of headingTexts) {
      const index = normalizedText.indexOf(heading, cursor);
      if (index < 0) {
        continue;
      }

      markers.push({ title: heading, startChar: index });
      cursor = index + heading.length;
    }

    if (!markers.length || markers[0].startChar > 140) {
      markers.unshift({
        title: fallbackTitle || "Intro",
        startChar: 0
      });
    } else {
      markers[0].startChar = 0;
    }

    const chapters = [];
    for (let i = 0; i < markers.length; i += 1) {
      const startChar = markers[i].startChar;
      const endChar = i + 1 < markers.length ? markers[i + 1].startChar : normalizedText.length;
      if (endChar - startChar < 80) {
        continue;
      }

      const sectionText = normalizedText.slice(startChar, endChar);
      chapters.push({
        index: chapters.length,
        title: markers[i].title || `Chapter ${chapters.length + 1}`,
        startChar,
        endChar,
        wordCount: countWords(sectionText)
      });
    }

    if (!chapters.length) {
      return [
        {
          index: 0,
          title: fallbackTitle || "Article",
          startChar: 0,
          endChar: normalizedText.length,
          wordCount: countWords(normalizedText)
        }
      ];
    }

    const lastChapter = chapters[chapters.length - 1];
    if (lastChapter.endChar < normalizedText.length) {
      lastChapter.endChar = normalizedText.length;
      lastChapter.wordCount = countWords(normalizedText.slice(lastChapter.startChar));
    }

    return chapters;
  }

  function extractReadableText(root) {
    const clone = root.cloneNode(true);

    clone
      .querySelectorAll(
        "script, style, noscript, nav, footer, header, form, button, aside, figure, iframe, svg, [aria-hidden='true'], .ads, .advertisement"
      )
      .forEach((node) => node.remove());

    return normalizeText(clone.textContent || "");
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

    return text.split(/\s+/).length;
  }

  function getSelectionText() {
    return (window.getSelection()?.toString() || "").trim();
  }

  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(Number(totalSeconds || 0)));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;

    if (minutes <= 0) {
      return `${remainder}s`;
    }

    if (minutes < 60) {
      return `${minutes}m ${remainder}s`;
    }

    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${hours}h ${remMinutes}m`;
  }

  function formatPlayerTime(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds || 0)));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;

    if (minutes < 60) {
      return `${minutes}:${String(remainder).padStart(2, "0")}`;
    }

    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${hours}:${String(remMinutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }

  function clampUiNumber(value, min, max) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) {
      return min;
    }

    return Math.min(max, Math.max(min, parsed));
  }

  function isExtensionContextValid() {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  }

  function isContextInvalidatedMessage(message) {
    return String(message || "").toLowerCase().includes("context invalidated");
  }

  function handleContextInvalidation(message) {
    if (uiState.runtimeInvalidated) {
      return;
    }

    uiState.runtimeInvalidated = true;
    applyRuntimeInvalidatedUI();
    showToast("AuraSpeech was updated. Reload this page to reconnect controls.", "warn");

    if (message) {
      console.warn("AuraSpeech content runtime invalidated:", message);
    }
  }

  function applyRuntimeInvalidatedUI() {
    if (!uiState.dock) {
      return;
    }

    const disabled = uiState.runtimeInvalidated;
    uiState.isScrubbing = false;
    uiState.dock.root.classList.remove("is-playing");
    uiState.dock.speakSelectionButton.disabled = disabled;
    uiState.dock.detectArticleButton.disabled = disabled;
    uiState.dock.listenArticleButton.disabled = disabled;
    uiState.dock.pauseResumeButton.disabled = disabled;
    uiState.dock.pauseResumeButton.classList.remove("is-live");
    uiState.dock.rewindButton.disabled = disabled;
    uiState.dock.forwardButton.disabled = disabled;
    uiState.dock.seekInput.disabled = true;
    uiState.dock.elapsedLabel.textContent = "0:00";
    uiState.dock.durationLabel.textContent = "0:00";
    uiState.dock.previousChunkButton.disabled = disabled;
    uiState.dock.nextChunkButton.disabled = disabled;
    uiState.dock.slowerButton.disabled = disabled;
    uiState.dock.fasterButton.disabled = disabled;
    uiState.dock.chapterSelect.disabled = true;
    uiState.dock.jumpChapterButton.disabled = true;
    uiState.dock.saveBookmarkButton.disabled = disabled;
    uiState.dock.resumeBookmarkButton.disabled = disabled;
    uiState.dock.stopButton.disabled = disabled;
    uiState.dock.advancedPanel.open = false;

    if (disabled) {
      uiState.dock.subtitle.textContent = "Reload page to reconnect";
      uiState.dock.progressText.textContent = "Extension context updated";
      uiState.dock.progressFill.style.width = "0%";
      uiState.dock.pill.textContent = "AuraSpeech (reload page)";
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      if (!isExtensionContextValid()) {
        handleContextInvalidation("Extension context is unavailable.");
        resolve({ ok: false, error: "Extension context invalidated." });
        return;
      }

      try {
        chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = chrome.runtime?.lastError;
          if (runtimeError) {
            if (isContextInvalidatedMessage(runtimeError.message)) {
              handleContextInvalidation(runtimeError.message);
            }
            resolve({ ok: false, error: runtimeError.message });
            return;
          }

          resolve(response);
        });
      } catch (error) {
        const msg = error?.message || String(error);
        if (isContextInvalidatedMessage(msg)) {
          handleContextInvalidation(msg);
        }
        resolve({ ok: false, error: msg });
      }
    });
  }
})();
