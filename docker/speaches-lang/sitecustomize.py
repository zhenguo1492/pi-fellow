"""Restrict Whisper's automatic language detection to a set of languages.

Loaded automatically by Python at startup (sitecustomize). When a request
carries no `language`, faster-whisper calls `WhisperModel.detect_language`;
this wrapper keeps its probabilities but picks the most likely language among
WHISPER_ALLOWED_LANGUAGES (comma-separated ISO-639-1 codes, default "zh,en").
An explicit `language` in the request bypasses detection and is unaffected.
"""
import os

_ALLOWED = [c.strip() for c in os.environ.get("WHISPER_ALLOWED_LANGUAGES", "zh,en").split(",") if c.strip()]
# Language kept on near-ties (default: first allowed) and how many times more likely another must be.
_PREFERRED = os.environ.get("WHISPER_PREFERRED_LANGUAGE", _ALLOWED[0] if _ALLOWED else "").strip()
_MARGIN = float(os.environ.get("WHISPER_LANGUAGE_MARGIN", "10"))

if _ALLOWED:
    try:
        from faster_whisper.transcribe import WhisperModel

        _original = WhisperModel.detect_language

        def _restricted_detect_language(self, *args, **kwargs):
            language, probability, all_probs = _original(self, *args, **kwargs)
            candidates = [(lang, p) for (lang, p) in (all_probs or []) if lang in _ALLOWED]
            if candidates:
                language, probability = max(candidates, key=lambda item: item[1])
                # Short clips give close scores; keep the preferred language unless
                # the winner beats it by a factor of _MARGIN.
                preferred = dict(candidates).get(_PREFERRED)
                if preferred is not None and language != _PREFERRED and probability < preferred * _MARGIN:
                    language, probability = _PREFERRED, preferred
                scores = " ".join(f"{lang}={p:.3f}" for (lang, p) in candidates)
                print(f"[sitecustomize] language {scores} -> {language}", flush=True)
            return language, probability, all_probs

        WhisperModel.detect_language = _restricted_detect_language
        print(f"[sitecustomize] Whisper language detection restricted to {_ALLOWED}", flush=True)
    except Exception as exc:  # never break the server over this patch
        print(f"[sitecustomize] language restriction not applied: {exc}", flush=True)
