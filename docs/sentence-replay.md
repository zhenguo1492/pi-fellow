# Read aloud and translate sentences (Alt+click / Alt+right-click)

Modeled on echo-read-edge's modifier-selection. Works in both the Bot view and the worker chat.

## Settings

- `voiceAgent.messageButtons` (default off): Settings → Voice → "Voice agent" → "Read aloud and translate sentences (Alt)". Messages have no buttons.
- When on, a "Translate into" dropdown sets `voiceAgent.translateTo`: 20 languages from `src/shared/translationLanguages.ts`, Google codes, default `zh-CN`.
- `voiceAgent.replayCacheSize`: speech cache size (default 30 messages/paragraphs).

## Webview side

- The host `VoicePanel` (`src/voiceAgent/voicePanel.ts`) sends `sentenceActions` to the whole webview whether or not the Bot view is shown: the toggle, the target language, and the sentence being read (`VoiceReplay`).
- `src/webview/sentenceActions.ts` stores it, sends `replay` / `translate`, plays audio with Web Audio when voice mode is off (`replayAudio` / `replayClipStarted` / `replayClipEnded`), and marks the sentence being read with CSS Custom Highlights (`vp-sentence-loading` → `vp-sentence-playing`).
- `src/webview/sentencePick.ts` is the single gesture controller: document-level, capture phase, it intercepts Alt+click / Alt+right-click so the page's own click handlers never see them. With the toggle off, Alt is not intercepted. While Alt is held it highlights the sentence under the pointer with `::highlight(vp-sentence-hover)` (no DOM changes).
- Where sentences are is decided by each "surface" (`SentenceSurface.pick` / `rangeOf`):
  - **Bot view** — `botSentences` in `src/webview/voicePanel.ts`: plain-text messages are split with `replayPieces` from `sentences.ts`, distinguished by `data-mode` on `.vp-body`; replies the voice agent spoke use one span per entry in their `sentences`; system lines are excluded.
  - **Chat** — `chatSentences` in `src/webview/chat/sentenceSurface.ts`: text in `.message-content` (prompts, replies, summaries), `.thinking-content` (Thought), and tool card `.tv-out` (e.g. a task's assignment), split per containing paragraph (p, li, headings, table cells, card text-block pre, etc.). Code blocks and buttons are excluded. The chat rebuilds history on every stateSync, so sentences are re-found by paragraph text; a `MutationObserver` triggers the re-find while a highlight is active.
- Highlight and popup styles are at the end of `main.css`.

## Read aloud (Alt+click)

- Sends `replay` (`VoiceReplayPiece` with a `range` or `sentence` index, `surface: bot|chat`). For chat, `entryId` is `chat\u0000<paragraph text>`; the host does not check it.
- `ReplayPlayer.toggle` in `src/voiceAgent/replay.ts` reads the sentence with the current TTS config (`resolveTtsConfig`). Clicking the same sentence again stops; another sentence replaces it.
- `VoiceReplay.phase` goes loading → queued → playing, driven by real playback reports (the hidden audio page's `started`, or the webview Web Audio's `replayClipStarted`).
- **Cache.** Audio is first looked up in `SpeechCache` (`src/voiceAgent/speechCache.ts`): in-memory FIFO keyed by `entryId` + `ttsCacheKey` (engine/url/model/voice/speed); `piece()` fetches by sentence text. A voice-mode reply whose every sentence synthesized successfully is `put` whole through `VoiceMode`'s `onSpoken` (`Speaker.takeSpoken`). On a miss TTS is called and the result is `add`ed to the same entry (all sentences of one message take one slot).
- Failures show a toast via `replayError`.
- **Voice mode on:** played in the hidden audio page via `VoiceMode.beginReplay` (Chrome AEC cancels it). Mic input is dropped during playback and for 300 ms after; speech within 3 s that overlaps the replayed text is dropped as echo (`echoFilter.isEchoOf`, also used as echo reference for barge-in). The voice agent starting to speak, hush, standby, or stop takes the speaker back.
- **Voice mode off:** the webview plays with Web Audio (`BotViewAudio`, `replayAudio` / `replayClipEnded`); dictation (`DictationSession.setPaused`) discards recorded audio meanwhile.

## Translate (Alt+right-click)

- Sends `translate` with a request id and target language `to`. `Translator` in `src/voiceAgent/googleTranslate.ts` calls Google `translate_a/single` (client=`dict-chrome-ex`) and replies with `translation`.
- Code spans are replaced by `⟪n⟫` placeholders and not sent for translation; if placeholders are lost, segments are translated one by one.
- If Google detects the text is already in the target language (for regional codes like zh-CN / zh-TW the region must also match), it replies `alreadyInTarget`.
- After a 429, requests pause per Retry-After.
- `src/webview/translatePopup.ts` shows a floating panel below the sentence (above if there is no room; `position: fixed`, clamped to the sentence's scroll container; title shows the target language), with an arrow pointing to the sentence end; the sentence stays highlighted with `vp-sentence-pinned`. The panel follows the sentence on scroll and redraw, closes when the sentence is gone or the toggle is turned off, and on Esc, outside click, or ×. Translations are cached per language + sentence text (200 entries).
