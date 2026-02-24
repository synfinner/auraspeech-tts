# AuraSpeech

AuraSpeech is a Manifest V3 browser extension that turns highlighted text or full articles into listenable audio using OpenAI text-to-speech.

## What is new

- Modernized MV3 architecture (service worker + offscreen audio document)
- Settings-focused popup for voice, speed, style, and API key management
- Compact in-page floating player (bottom-right) with pause/resume/stop and collapse
- Floating in-page player is enabled by default
- Article extraction heuristics for podcast-style listening mode
- Chapter-aware article playback with jump controls
- Bookmark save/resume for long-form sessions
- Automatic temporary chunk-audio caching to avoid regenerating already-heard portions
- In-player timeline seeking for currently playing chunk (normal audio-player style)
- Chunked speech generation for long content while honoring API limits

## OpenAI usage

AuraSpeech calls `POST https://api.openai.com/v1/audio/speech` with `gpt-4o-mini-tts-2025-12-15`.

Current request constraints used by the extension:

- Input is chunked to stay below the API per-request text limit (4096 chars)
- Chunk compaction merges undersized neighboring chunks to reduce call count
- Duplicate long paragraphs are deduplicated before chunking to avoid resend bloat
- Default built-in narration instructions are not re-sent on every chunk unless customized
- Speed is clamped to `0.25` to `4.0`
- Voice options include current built-in voices (for example `marin`, `cedar`, `alloy`, `nova`)
- In-flight speech requests are aborted when playback is stopped
- 429/5xx responses are retried with backoff
- SSE streaming is used when available, with automatic MP3 fallback
- Adaptive delivery mode:
  - First chunk uses SSE for first-audio latency
  - Stable long chunks can switch to batch MP3 mode for throughput
  - Chunk sizing adapts based on observed latency/error signals
- Previously generated chunk audio is reused automatically (within cache budget) when navigating back
- Pipeline states are exposed to UI (`extracting` -> `generating` -> `buffering` -> `playing`)
- Session caps limit total API speech calls per listening session

## Install

1. Open `chrome://extensions/`
2. Enable Developer mode
3. Click **Load unpacked** and choose this folder
4. Open AuraSpeech popup and save your OpenAI API key

## Usage

### Speak selected text

1. Highlight text on any page
2. Right-click and choose **AuraSpeech: Speak Selection**

### Listen to a full article

1. Open an article page
2. Use the in-page AuraSpeech player to **Detect article**
3. Start playback with **Listen article**

## Notes

- API keys are stored in `chrome.storage.local` under a dedicated key, with storage access restricted to trusted extension contexts
- Legacy plaintext keys in old fields are auto-migrated and removed
- For strict production security/compliance, use a server-side relay so end users never handle raw provider API keys
- Long pages can be expensive; AuraSpeech enforces a per-session API-call ceiling
- Some protected pages (for example browser internal pages) do not allow content scripts
