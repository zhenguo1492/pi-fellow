# speaches with Whisper auto-detection limited to WHISPER_ALLOWED_LANGUAGES (default zh,en; compose overrides it).
# Build: docker build -t speaches-lang docker/speaches-lang
FROM ghcr.io/speaches-ai/speaches:latest-cuda

ENV WHISPER_ALLOWED_LANGUAGES=zh,en
COPY sitecustomize.py /home/ubuntu/speaches/.venv/lib/python3.12/site-packages/sitecustomize.py
