# Voice input, speech services, and voice settings

Covers dictation, STT/TTS service configuration, the built-in engine, API keys, and the Voice settings tab. The voice agent itself is in [voice-agent.md](./voice-agent.md).

## Dictation (`src/voice/`)

Classes: `VoiceInput`, `DictationSession`, `SileroVad`, `SpeechSegmenter`, `SttClient` (`stt.ts`), `MicLevelMeter` (`micLevel.ts`).

- `DictationSession<T>` runs each utterance through a `SegmentHandler<T>`: dictation's is `transcribeUtterance(stt, gate)` (text, gated by the voiceprint); the settings' voiceprint recordings use the same capture with embedding handlers. Results are delivered in speaking order, `undefined` delivers nothing.
- The webview cannot access the microphone, so the extension host records 16 kHz mono PCM with `arecord` / `parecord` / sox `rec`.
- Silero VAD (`media/vad/silero_vad.onnx`, taken from pipecat; onnxruntime-web WASM, single-threaded; runtime files are copied by esbuild to `out/vad/`) splits speech at pauses (state machine same as pipecat's `VADAnalyzer`).
- Each utterance is POSTed immediately to the OpenAI-compatible `/audio/transcriptions` at `oh-my-pi-chater.voice.sttUrl`; the text is inserted at the composer cursor in speaking order.
- `src/webview/dictation.ts` is the mic button; command `oh-my-pi-chater.toggleDictation`.

## Voiceprint: only your voice (`src/voice/voiceprint.ts`, `speakerGate.ts`)

So that people talking nearby (kids, a TV) are neither dictated nor answered by voice mode.

- **Enrollment** (Settings → Voice, "Only my voice" → Record, `src/webview/voiceprintDialog.ts`): `VoiceDryRun.startVoiceprint('enroll')` records with the dictation capture (`asSpoken`); the user reads `VOICEPRINT_PROMPTS` (`src/shared/voiceprint.ts`), one recording each, and recordings under `MIN_ENROLL_SECS` (1.5 s) are asked for again. Each is embedded by the engine's `/speaker/embed`; `saveVoiceprint` L2-normalizes each, averages, re-normalizes (`voiceprintCentroid`) and stores centroid + the individual embeddings + the speaker model id in **globalState** (`oh-my-pi-chater.voice.voiceprint`), never settings.json, then turns `voice.voiceprint.enabled` on. A voiceprint from another speaker model is `stale`: unused until recorded again.
- **Test** (`startVoiceprint('test')`): each utterance's similarity, threshold and verdict, live.
- **Gate** (`speechGate`, a `SpeechGate`): `prepare` (noise reduction when `voice.denoise` is on) then `accept` = cosine similarity to the centroid ≥ `voice.voiceprint.threshold` (default 0.5). Utterances under 1 s follow `voice.voiceprint.shortSpeech`: `stricter` (threshold + 0.1, default) or `accept` (unchecked). Rejections are logged to the output channel with their similarity.
  - Dictation: STT and the check run in parallel (`transcribeChecked`); a rejected utterance's text is dropped, order kept.
  - Voice mode (`VoiceMode`, option `gate`): `_finishSegment` drops a rejected utterance (its `transcript` event goes out empty, closing the `userSpeechEnd` already dispatched; a confirmed barge-in's own text still stands in). `_verifyBargeIn` rejects a candidate in another voice, so it cannot cut the bot off; while the gate is active, speech during a reply that is still being generated (not playing) is also a candidate, checked for your voice only (no echo check).
  - Status while the gate is active: a new segment is first `userSoundStart` → phase `soundDetected` ("Detecting speech"). It holds the floor (`floorFree`/`tryPrompt` wait, no proactive turn) but cuts nothing off. `_checkSound` runs `prepare` + `accept` on the latest 1.5 s once about 1 s is heard (enough to be compared, not let through as short), again after each further second while rejected; a pass dispatches `userSpeechStart` ("Hearing you") while the user still talks. A segment never confirmed early goes straight to transcribing; if its final check passes, its `transcript` cuts off any reply still under way. A barge-in candidate taking the audio over ends the sound with `userSoundEnd`.
  - Off, or without a usable voiceprint: `ACCEPT_UNCHECKED`, today's behavior.
  - The engine failing (download, start, request): the gate accepts (`reason: 'unavailable'`), noise reduction passes audio through, and `voiceprintStatus().warning` shows in the section's status line until a check works again. Nothing is dropped because of it.
- Thresholds measured with the model on sherpa-onnx's speaker test recordings: same speaker 0.78–0.87 (full utterances), 0.49–0.65 (0.5–1 s); other speakers −0.02–0.31.

## API keys

- Cloud API keys are stored per provider in VS Code SecretStorage (`oh-my-pi-chater.voice.apiKey.<provider>`, e.g. `.openai`, `.groq`). They never go into settings.json or to the webview; the webview only knows whether each provider has a key.
- Legacy per-service keys (`voice.sttApiKey` / `voiceAgent.tts.apiKey`) are moved on activation to the provider matching their URL.
- When the URL is a cloud service (an address in `VOICE_PRESETS`) and that provider has a key, every request (transcription, synthesis, `/models` probe, Save & test / Dry run) sends `Authorization: Bearer`. The user's own server never gets a key (`apiKeySource` / `sendsApiKey` in `src/voice/voiceSettings.ts`).
- `SttConfig.apiKey` / `TtsRequestConfig.apiKey` are functions read on each request, so key changes apply immediately; a change re-probes that service.
- Test / Dry run prefer an unsaved key typed into the field; in that case the Test result is not recorded as readiness.
- The built-in engine never sends a key.

## Voice settings tab (`src/webview/settings/voiceSetup.ts`)

Three sub-tabs (`src/webview/settings/voiceTabs.ts`, ARIA tablist; arrows / Home / End move between them): **Voice engine** (help, setup cards, own-server fields), **Listening and speaking** (language, listening, speed, Try buttons, "Only my voice"), **Voice agent** (names and avatars, skills, sentence actions). Panels only hide, so fields and listeners stay live. The chosen sub-tab is `settingsState.voiceSubtab`, kept in the webview state; a deep link (`scrollToSection`: `voice`, `stt`, `tts`, `voice-listening`, `voiceprint`, `voice-agent`) opens the sub-tab holding that section.

Voice engine has three cards — **Built-in**, **Cloud service**, **My own server** — that only map onto the existing settings (`deriveVoiceSetup` infers the current card from settings).

- **Built-in** shows whether the engine and its models are downloaded and their size, with "Download now" (`builtinVoiceStatus` / `prepareBuiltinVoice`).
- **Cloud** picks OpenAI or Groq from `src/shared/voicePresets.ts` (`CLOUD_PROVIDERS` includes the key page; `VOICE_PRESETS` holds each service's URL/models).
  - Groq's voice is Orpheus: English only, at most 200 characters per request (`VoicePreset.maxInputChars` → `TtsRequestConfig.maxInputChars`). `TtsClient` splits longer sentences at punctuation/spaces, requests each part, and concatenates.
  - "Get API key" opens via the host's `openExternal`.
  - Each provider has a Voice dropdown (`VoicePreset.voices`, first entry is the recommended default, written to `voiceAgent.tts.voice`) and "Try…" to preview.
  - The card shows whether the selected provider's key is saved (with Remove). Switching provider clears a pasted-but-unsaved key. "Save & test" stores a pasted key for that provider, saves settings, and tests.
- **My own server** fields are recorded in globalState before and after each save (`oh-my-pi-chater.voice.ownServers`, `rememberOwnServers`). After a Cloud / Built-in save overwrites them, clicking My own server restores them.
  - Shows only URL / model (TTS also voice and `languageField`) plus a local docker example; no Engine dropdown and no key. The engine is a hidden field: non-empty URL → `custom`, empty → built-in for that part.
  - On Test, if the model is empty or not on the server, the first model for that task from `/models` is used (speaches distinguishes STT / TTS by `task`, see `modelIdsFor`) and filled into the model field as an unsaved change.
- All fields are drafts: Save / Discard at the bottom of Voice engine and Listening and speaking (the sub-tabs with draft fields) with an "Unsaved changes" indicator, and a dot on each sub-tab holding an unsaved draft (a pasted key or a change not tied to one field goes on Voice engine). Each section's Test only tests, never saves. Leaving the tab prompts; closing the panel with unsaved changes warns.

## Error explanations

Service failures (unreachable, 401/403, 404, timeout, 429, 5xx) are turned into plain language plus a next step by `explainVoiceError` in `src/voice/voiceErrors.ts`. Used for settings results, readiness reasons, and dictation / voice mode errors. The raw error is still logged.

## Built-in engine (`src/voice/builtinEngine/`)

Zero-install: Moonshine base (English STT), Piper en_US lessac (English TTS), a speaker embedding model (3D-Speaker CAM++ zh+en, 192-dim, 28 MB, the voiceprint) and GTCRN (0.5 MB, noise reduction) via sherpa-onnx-node (N-API prebuilt). Neither the runtime nor the models ship in the VSIX, so one universal VSIX serves every platform.

- `server.ts` is bundled to `out/voice-engine/server.js` and started by `engine.ts` (`BuiltinVoiceEngine`) as a child process using `process.execPath` + `ELECTRON_RUN_AS_NODE=1`.
- Listens on 127.0.0.1 on a random port; paths carry a random token (`/<token>/v1/models`, `/audio/transcriptions`, `/audio/speech`), OpenAI-compatible like `SttClient` / `TtsClient`; plus private `POST /speaker/embed` (WAV → `{ model, embedding }`) and `POST /audio/denoise` (WAV → WAV), each model on its own serial queue so a check never waits behind a transcription.
- **Features** (`EngineFeature`: `stt`, `tts`, `speaker`, `denoise`): a server loads only the models it is started with; the others' endpoints answer 503. `builtinVoiceEngineUrl(features)` starts it with those plus what the settings use (`builtinEngineFeatures`), and restarts it on the same port with a feature added when one is missing. With a custom STT and TTS and the voiceprint on, it runs the speaker model alone.
- Exits when stdin closes. After a crash it restarts on the same port and token, with the same features; more than 3 crashes within a minute waits for the next use.
- In Electron, TTS must use `enableExternalBuffer: false`.
- **Runtime** (`runtime.ts`): sherpa-onnx-node and this platform's binary package (`sherpa-onnx-<win|linux|darwin>-<arch>`, from `platformPackage`) at `SHERPA_ONNX_VERSION` (exact, the one constant to bump). On first use `planRuntimeDownload` looks both up in the npm registry (`registry.npmjs.org/<pkg>/<version>`); `downloadRuntime` fetches each tarball, checks it against the registry's `dist.integrity` (sha512), unpacks it (built-in tar reader: regular files and directories only, paths confined to the package) and publishes `globalStorage/voice-runtime/<version>-<platform>-<arch>/node_modules/` by renaming its `.partial` directory once both packages are in. The binary package sits beside sherpa-onnx-node, where its loader looks. Platforms without a binary package (e.g. Windows on ARM) fail before anything downloads, pointing to a custom server. `server.ts` requires the absolute path it gets in `EngineConfig.sherpaPath`; when the addon does not load, its last stderr line (what the start error shows) names the folder to delete so it downloads again.
- Models are not bundled. On first use (dictation, voice mode, settings Test / Dry run, voiceprint recording) the ones a feature needs are downloaded (`downloadModels`, `models.ts`) to `globalStorage/voice-models` from Hugging Face at a pinned commit. Each file is verified against that commit's sha256 (LFS) / git blob sha1; only when all pass is `.partial` renamed into place.
- One progress notification covers both, runtime first (the models are no use without it). Its title shows the real total (runtime unpacked size from the registry, model files listed by `planModelDownload`); it can be cancelled. The settings status counts both too.

## Engine selection

- `voice.sttEngine` and `voiceAgent.tts.engine` are each `builtin` / `custom`. When not set explicitly, a configured URL means the custom service, otherwise built-in.
- `resolveSttConfig` / `resolveTtsConfig` in `src/voice/voiceSettings.ts` swap the built-in engine for its actual URL at call time.
- The built-in engine always counts as available in readiness checks (it starts on use; failures are reported where it is used).

## Readiness

`voiceReadiness()` is not based only on `/models` probes. `resolveSttConfig` / `resolveTtsConfig` attach `onOutcome` to the config, and every real transcription / synthesis (voice mode, dictation, read-aloud, Dry run) records a result against the settings actually used:

- Available: HTTP success (an empty transcription counts).
- Unavailable: unreachable, HTTP error, timeout, not 16-bit mono WAV.
- Not recorded: caller cancellation; results for settings that have since changed are discarded.

The status bar tags follow in real time; one success clears a failure. 404 / format / 400-class failures are sticky: a successful probe does not clear them, only a real success or a settings change does. A built-in engine that fails to start is also recorded unavailable, then forgotten on the next probe so it retries. How the voice agent reacts to missing services is in [voice-agent.md](./voice-agent.md#when-stt-or-tts-is-unavailable).
