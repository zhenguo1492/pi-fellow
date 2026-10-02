# Local voice services

Self-hosted speech services for Pi Fellow's voice input and voice agent, run with Docker Compose.

## Run commands

From the repo root (or drop `-f docker/docker-compose.yml` inside `docker/`). Naming a service starts it even if its profile is not enabled.

```sh
# Everything: stt + Kokoro (GPU image if nvidia-smi works, else CPU) + chatterbox (GPU only)
docker/up.sh

# Only Kokoro, GPU image
docker compose -f docker/docker-compose.yml up -d tts
# Only Kokoro, CPU image
docker compose -f docker/docker-compose.yml up -d tts-cpu

# Only chatterbox
docker compose -f docker/docker-compose.yml up -d chatterbox

# Only Whisper STT (builds speaches-lang the first time)
docker compose -f docker/docker-compose.yml up -d stt

# A combination, e.g. STT + Kokoro
docker compose -f docker/docker-compose.yml up -d stt tts

# Logs, stop one, stop all
docker compose -f docker/docker-compose.yml logs -f chatterbox
docker compose -f docker/docker-compose.yml stop tts
docker compose -f docker/docker-compose.yml --profile gpu --profile cpu down
```

`tts` and `tts-cpu` share the container name `kokoro-tts` and port 8880: run one of them. `down` without both `--profile` flags leaves the profiled services (Kokoro, chatterbox) running.

| Service | What runs | Endpoint (OpenAI-compatible) | Pi Fellow setting |
|---|---|---|---|
| `stt` | [speaches](https://github.com/speaches-ai/speaches) with faster-whisper (`Systran/faster-whisper-large-v3`), speech to text | `http://127.0.0.1:8010/v1` | `oh-my-pi-chater.voice.sttUrl` |
| `tts` / `tts-cpu` | [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), text to speech | `http://127.0.0.1:8880/v1` | `oh-my-pi-chater.voiceAgent.tts.url` |
| `chatterbox` (profile `gpu`) | chatterbox-tts (`chatterbox-multilingual`), text to speech that clones a voice from `voices/` | `http://127.0.0.1:8881/v1` | `oh-my-pi-chater.voiceAgent.tts.url`, model `chatterbox-multilingual`, voice a file name such as `Justin.mp3`, language field "per sentence" |

`stt` and `chatterbox` listen on 0.0.0.0, so other machines on the LAN reach them at this host's address (`http://<host>:8010/v1`, `http://<host>:8881/v1`); neither asks for a key, so keep them off untrusted networks. Kokoro listens on 127.0.0.1 only.

## chatterbox

The image `local/chatterbox-tts:0.2.0` is not on a registry: build it from the chatterbox-docker repo (a fork of [resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox) with `server.py`, the OpenAI-compatible server, and a `Dockerfile` on `pytorch/pytorch:2.6.0-cuda12.6-cudnn9-runtime`), e.g. `docker build -t local/chatterbox-tts:0.2.0 .` there.

### Running configuration

What `docker-compose.yml` runs, the same as the chatterbox-tts container in use:

| Item | Value | Meaning |
|---|---|---|
| Port | `0.0.0.0:8881` → `8000` | OpenAI-compatible `POST /v1/audio/speech`, `GET /v1/models`, `GET /v1/languages`, `GET /health` |
| GPU | all NVIDIA GPUs, `CHATTERBOX_DEVICE=cuda` | Runs on CUDA only |
| `shm_size` | `2gb` | Shared memory for PyTorch |
| `restart` | `unless-stopped` | Comes back after a reboot unless stopped by hand |
| Health check | `GET /health` every 15 s, 5 retries, `start_period: 10m` | The 10 minutes cover the first model download |
| `voices/` → `/voices` (read-only) | `Charles.mp3`, `Justin.mp3`, `Marcus.mp3`, `Olivia.mp3`, `cedar.wav`, `kitty.wav`, `zephyr.wav` | Reference voices; a request's `voice` is the file name, `default` is the checkpoint's own voice |
| Volume `chatterbox-docker_chatterbox-hf-cache` → `/root/.cache/huggingface` | about 10 GB | Model cache (`HF_HOME`), shared with the chatterbox-docker project |

Environment (each can be overridden from the shell or a `docker/.env`, e.g. `CHATTERBOX_MAX_CONCURRENCY=2 docker/up.sh`):

| Variable | Value | Meaning |
|---|---|---|
| `CHATTERBOX_MODEL` | `multilingual` | Checkpoint loaded: `multilingual` (`chatterbox-multilingual`, 23 languages), `turbo` / `nano` (English only). One per container |
| `CHATTERBOX_T3_MODEL` | `v3` | Multilingual checkpoint, `v3` or `v2` |
| `CHATTERBOX_CFG_WEIGHT` | `0.3` | Multilingual only, 0–1: how strongly the model follows the text; lower reads slower and steadier (upstream: 0.5) |
| `CHATTERBOX_SENTENCE_PAUSE_MS` | `400` | Silence between sentences, 0–2000 ms; each sentence is synthesized on its own |
| `CHATTERBOX_SPELL_NUMBERS` | `1` | Spell numbers out in the text's language (`3个` → `三个`); `0` sends digits |
| `CHATTERBOX_SPELL_ACRONYMS` | `1` | Read initialisms letter by letter (`API` → `A-P-I`); `0` reads them as one word |
| `CHATTERBOX_ACRONYM_EXCEPTIONS` | empty | Extra abbreviations read as words, e.g. `SQL,PNG` |
| `CHATTERBOX_MAX_CONCURRENCY` | `1` | Syntheses sharing the loaded model, 1–16; more slots trade latency for throughput |

The per-request fields `cfg_weight`, `sentence_pause_ms`, `spell_numbers`, `spell_acronyms` override these defaults.

Pi Fellow settings for it: `oh-my-pi-chater.voiceAgent.tts.engine` `custom`, `tts.url` `http://127.0.0.1:8881/v1`, `tts.model` `chatterbox-multilingual`, `tts.voice` a file from `voices/` (e.g. `Justin.mp3`), `tts.languageField` `perSentence` (sends `zh` for sentences with Chinese, else `en`; without `en` the multilingual model mangles English).

### Voices: the `voices/` mount

```yaml
volumes:
  - ./voices:/voices:ro
```

- Host side: `docker/voices/` (relative to `docker-compose.yml`), mounted read-only at `/voices` in the container. It holds `Charles.mp3`, `Justin.mp3`, `Marcus.mp3`, `Olivia.mp3`, `cedar.wav`, `kitty.wav`, `zephyr.wav`, copied from the chatterbox-docker project.
- A request's `voice` is a path relative to `/voices`: `Justin.mp3`, or `team/alice.wav` for a subfolder. `default` (or no `voice`) is the checkpoint's built-in voice. A path outside `/voices` → HTTP 400, an unsupported extension → 400, a missing file → 404 `voice file not found`.
- Formats: `.wav`, `.mp3`, `.flac`, `.ogg`, `.m4a`. A clean recording of one speaker, 10–20 s (at least 5 s), no music or noise.
- Add or replace a file and use it right away, no restart: the server encodes a voice on the first request that names it and caches it by path and modification time, so a replaced file is encoded again. `GET /v1/voices` lists what it sees.
- To use another folder, change the host side of that line, e.g. `- /data/my-voices:/voices:ro`, then `docker compose -f docker/docker-compose.yml up -d chatterbox` to recreate the container.
- Clone a voice only with the speaker's permission.

## Kokoro voices

Kokoro has 68 built-in voices and no voice files. The name's first letter is the language, the second the gender (`f` / `m`):

| Prefix | Language (`lang_code`) | Voices |
|---|---|---|
| `af_` / `am_` | American English (`a`) | `af_heart`, `af_bella`, `af_sarah`, `af_nicole`, `af_sky`, … / `am_adam`, `am_michael`, `am_echo`, … |
| `bf_` / `bm_` | British English (`b`) | `bf_emma`, `bf_alice`, `bf_lily`, … / `bm_george`, `bm_lewis`, `bm_daniel`, … |
| `zf_` / `zm_` | Mandarin Chinese (`z`) | `zf_xiaobei`, `zf_xiaoni`, `zf_xiaoxiao`, `zf_xiaoyi` / `zm_yunjian`, `zm_yunxi`, `zm_yunxia`, `zm_yunyang` |
| `jf_` / `jm_` | Japanese (`j`) | `jf_alpha`, `jf_gongitsune`, `jf_nezumi`, `jf_tebukuro` / `jm_kumo` |
| `ef_` `em_`, `ff_`, `hf_` `hm_`, `if_` `im_`, `pf_` `pm_` | Spanish (`e`), French (`f`), Hindi (`h`), Italian (`i`), Brazilian Portuguese (`p`) | `ef_dora`, `ff_siwis`, `hf_alpha`, `if_sara`, `pf_dora`, … |

`GET http://127.0.0.1:8880/v1/audio/voices` lists all of them.

- `voice`: one name, or a mix: `af_bella+af_sky` (equal parts), `af_bella(2)+af_sky(1)` (weighted).
- `lang_code`: the language the text is read in. Unset, Kokoro takes it from the voice's first letter. `z` reads Chinese clearly even with an English voice; an English voice without `z` reads Chinese as "Chinese letter".
- `model`: `kokoro` (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` are aliases). `speed`: 0.25–4.
- `response_format`: `mp3` (default), `wav`, `opus`, `aac`, `flac`, `pcm` (16-bit mono 24 kHz, no header).

Pi Fellow settings for it: `oh-my-pi-chater.voiceAgent.tts.engine` `custom`, `tts.url` `http://127.0.0.1:8880/v1`, `tts.model` `kokoro`, `tts.voice` a name from the table, `tts.languageField` `chineseLangCode`, `tts.speed` as wanted. `chineseLangCode` sends Chinese runs with `lang_code: z` and the rest without it, each run its own request, because `z` on a whole mixed sentence mangles English (`npm test` → "能试试"). With an English voice (`af_sarah`, `af_heart`) mixed Chinese and English reads best; a Chinese voice (`zf_xiaobei`) also reads the English runs in its Chinese pipeline, so pick it only for mostly Chinese replies.

## STT languages: `speaches-lang`

`speaches-lang/` is what makes speech recognition pick the right language. Whisper detects the language of each utterance on its own, out of 100 languages; on short clips it can guess wrong (Chinese heard as Japanese, for instance) and then transcribes in the wrong language. `speaches-lang` builds on the official `speaches:latest-cuda` image and adds `sitecustomize.py`, which Python loads at startup: Whisper still scores every language, but the result is chosen only among the languages you speak. The model itself is unchanged.

**Set it to your own languages.** The default `zh,en` is for someone who speaks Chinese and English. Use the ISO-639-1 codes of the languages you speak:

| You speak | `WHISPER_ALLOWED_LANGUAGES` |
|---|---|
| Chinese and English | `zh,en` (default) |
| English only | `en` |
| Japanese and English | `ja,en` |
| German, English, French | `de,en,fr` |
| Chinese, English, Japanese | `zh,en,ja` |

Codes are Whisper's: `zh` (Mandarin; Cantonese is `yue`), `en`, `ja`, `ko`, `de`, `fr`, `es`, `ru`, …; `curl http://127.0.0.1:8010/v1/models` lists all the model knows.

| Variable | Default | Meaning |
|---|---|---|
| `WHISPER_ALLOWED_LANGUAGES` | `zh,en` | Languages detection may pick, comma-separated; the most likely of them wins. `,` (no codes) turns the restriction off; an empty value falls back to `zh,en` |
| `WHISPER_PREFERRED_LANGUAGE` | the first of the list | Kept when scores are close, as on short clips. Not in the compose file; add it under `stt.environment` to set it |
| `WHISPER_LANGUAGE_MARGIN` | `10` | How many times more likely another allowed language must be to beat the preferred one. Lower switches more readily; `1` just takes the most likely |

Order matters: put the language you speak most first. Set them in `docker/.env` or the shell, then recreate the container (no rebuild needed, they are read at startup):

```sh
echo 'WHISPER_ALLOWED_LANGUAGES=ja,en' >> docker/.env
docker compose -f docker/docker-compose.yml up -d stt
```

Check what it picks: each detection is logged with the scores of the allowed languages.

```sh
docker logs whisper-speaches 2>&1 | grep sitecustomize
# [sitecustomize] Whisper language detection restricted to ['zh', 'en']
# [sitecustomize] language zh=0.991 en=0.003 -> zh
# [sitecustomize] language en=0.322 zh=0.003 -> en
```

A request that names its `language` skips detection altogether. Pi Fellow sends one when `oh-my-pi-chater.voice.language` is set (e.g. `zh`); leave it empty when you switch between languages, so each utterance is detected within the allowed list. Testing by hand: `-F language=zh` on `/v1/audio/transcriptions` (see [Test](#test)).

## Hardware

All GPU services need an NVIDIA driver plus [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/) so Docker can see the GPU.

**STT (required: NVIDIA GPU)**
- NVIDIA GPU with CUDA and about 5 GB free VRAM for `large-v3` (measured: 4.1 GB).
- Disk: about 9 GB for the image, about 3 GB for the model (cached in `~/.cache/huggingface`).
- Without a GPU, use the `speaches:latest-cpu` base image and a smaller model (`small` or a `distil` model); `large-v3` on a CPU takes several seconds per sentence.

**Kokoro TTS (GPU optional)**
- With an NVIDIA GPU: the GPU image, about 2 GB VRAM.
- Without one: the CPU image; Kokoro is small and runs fine on a modern CPU.

**chatterbox TTS (required: NVIDIA GPU)**
- VRAM: about 7 GB for `multilingual` with `CHATTERBOX_MAX_CONCURRENCY=1` (measured: 6.8 GB); each extra concurrency slot adds that request's KV cache and activations, not another copy of the model.
- Driver: the image ships the CUDA 12.6 runtime (PyTorch 2.6), so an NVIDIA driver for CUDA 12 (525 or newer; 560 or newer for full 12.6 support).
- RAM: about 3 GB for the server process.
- Disk: about 11.5 GB for the image, about 10 GB for the models.
- No CPU setup here: the compose file sets `CHATTERBOX_DEVICE=cuda`.

**Everything at once** (`stt` + `tts` + `chatterbox`): about 13 GB VRAM (4.1 + 2 + 6.8), so a 16 GB GPU or larger; Whisper and chatterbox measured together on an RTX 4090 (24 GB), driver 595. Disk about 35 GB. 16 GB RAM is comfortable.

## Start

```sh
chmod +x docker/up.sh   # once
docker/up.sh
```

`up.sh` checks `nvidia-smi`: if a GPU is usable it starts profile `gpu` (Kokoro GPU image and `chatterbox`), otherwise profile `cpu` (Kokoro CPU image). `stt` has no profile and always starts. Extra arguments go to `docker compose up`, e.g. `docker/up.sh --build`; to start only chatterbox: `docker compose -f docker/docker-compose.yml --profile gpu up -d chatterbox`.

Compose warns that `chatterbox-docker_chatterbox-hf-cache` "was created for project chatterbox-docker"; that is the shared model volume and the warning is harmless. It is not marked `external` so a machine without it gets it created.

The first start builds `speaches-lang` and downloads the images; the Whisper model downloads on the first transcription.

If a container named `whisper-speaches`, `kokoro-tts` or `chatterbox-tts` was started by hand or by another Compose project (chatterbox-docker), remove it first (`docker rm -f chatterbox-tts`), or Compose reports a name conflict.

## Test

Each service answering, then speech you can hear, then a round trip (TTS → STT) that checks the words. Play with `aplay` / `paplay` / `pw-play` on Linux, `afplay` on macOS, or `ffplay -autoexit -nodisp` / `mpv` anywhere.

### Up and loaded

```sh
curl http://127.0.0.1:8010/v1/models          # Whisper: Systran/faster-whisper-large-v3
curl http://127.0.0.1:8880/v1/models          # Kokoro: kokoro, tts-1, …
curl http://127.0.0.1:8880/v1/audio/voices    # Kokoro voices
curl http://127.0.0.1:8881/health             # {"status":"ok","model":"chatterbox-multilingual","device":"cuda"}
curl http://127.0.0.1:8881/v1/voices          # chatterbox: default + the files in voices/
curl http://127.0.0.1:8881/v1/languages       # chatterbox: the 23 language ids
docker compose -f docker/docker-compose.yml ps   # chatterbox shows (healthy) once loaded
```

### Kokoro: synthesize and play

```sh
# Chinese, to a file, then play
curl http://127.0.0.1:8880/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"model":"kokoro","voice":"zf_xiaobei","lang_code":"z","input":"你好，我是本地语音服务。","response_format":"wav"}' \
  -o kokoro-zh.wav && aplay kokoro-zh.wav

# English with a voice mix, MP3
curl http://127.0.0.1:8880/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"model":"kokoro","voice":"af_bella(2)+af_sky(1)","input":"The tests passed.","response_format":"mp3"}' \
  -o kokoro-en.mp3 && paplay kokoro-en.mp3

# Streamed straight to the speaker as raw PCM
curl -sS http://127.0.0.1:8880/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"model":"kokoro","voice":"af_heart","input":"Streaming from Kokoro.","stream":true,"response_format":"pcm"}' \
  | aplay -q -f S16_LE -r 24000 -c 1
```

### chatterbox: synthesize and play

```sh
# Cloned voice from voices/Justin.mp3, Chinese with English words, to a file, then play
curl http://127.0.0.1:8881/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"model":"chatterbox-multilingual","voice":"Justin.mp3","language":"zh","input":"好的，我来跑一下 npm test。","response_format":"wav"}' \
  -o cb-zh.wav && aplay cb-zh.wav

# Built-in voice, English. Unset, language is detected from the script (Han → zh, kana → ja, hangul → ko, else en);
# send it for languages written in Latin letters other than English, e.g. "de"
curl -sS http://127.0.0.1:8881/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"model":"chatterbox-multilingual","voice":"default","language":"en","input":"The tests passed."}' \
  | aplay -q

# Streamed as raw PCM (stream needs response_format pcm), another voice file
curl -sS http://127.0.0.1:8881/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"model":"chatterbox-multilingual","voice":"cedar.wav","input":"Streaming from chatterbox.","stream":true,"response_format":"pcm"}' \
  | aplay -q -f S16_LE -r 24000 -c 1
```

chatterbox returns `wav` (default) or `pcm` only. A missing voice file answers `{"detail":"voice file not found: …"}`.

### Round trip: TTS → Whisper

Transcribing the files made above checks both sides without listening:

```sh
curl http://127.0.0.1:8010/v1/audio/transcriptions \
  -F file=@kokoro-zh.wav -F model=Systran/faster-whisper-large-v3
# {"text":"你好,我是本地语音服务。"}

curl http://127.0.0.1:8010/v1/audio/transcriptions \
  -F file=@cb-zh.wav -F model=Systran/faster-whisper-large-v3 -F language=zh -F response_format=text
# 好的,我来跑一下MPN Test。
```

Add `-F language=zh` (or `en`) to skip language detection, `-F response_format=text` for plain text. To test the microphone path, record yourself and send that: `arecord -f S16_LE -r 16000 -c 1 -d 5 me.wav`, then the same `curl` with `file=@me.wav`.

In Pi Fellow, the Voice settings tab has a Test button next to the STT and TTS URL fields: it checks the server and shows its model list.
