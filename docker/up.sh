#!/usr/bin/env sh
# Start the voice services; Kokoro runs on the GPU when one is usable, else on the CPU.
set -e
cd "$(dirname "$0")"
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  profile=gpu
else
  profile=cpu
fi
echo "Kokoro: $profile"
docker compose --profile "$profile" up -d "$@"
