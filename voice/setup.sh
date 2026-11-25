#!/usr/bin/env bash
# Creates voice/.venv and downloads the Whisper model (the only network step; the sidecar never downloads).
# Usage: voice/setup.sh [model...]   (default: ${JARVIS_VOICE_MODEL:-large-v3} plus large-v3-turbo, the CPU/fallback model)
set -euo pipefail
cd "$(dirname "$0")"
[ $# -gt 0 ] || set -- "${JARVIS_VOICE_MODEL:-large-v3}" large-v3-turbo
PY="${JARVIS_VOICE_PYTHON_BASE:-python3}"
[ -x .venv/bin/pip ] || "$PY" -m venv --clear .venv  # --clear: a half-made venv recovers
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet faster-whisper numpy nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"  # same as pyproject.toml; no package to build
.venv/bin/python - "$@" <<'PY'
import sys, pathlib
from faster_whisper.utils import download_model
for name in dict.fromkeys(sys.argv[1:]):
    path = pathlib.Path(download_model(name))
    size = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())  # follows HF cache symlinks
    print(f"model {name} ready at {path}: {size / 2**20:.0f} MiB")
PY
echo "done. Use JARVIS_VOICE_PYTHON=$(pwd)/.venv/bin/python"
