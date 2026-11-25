"""Jarvis voice sidecar: speech-to-text over stdin/stdout.

Protocol (binary in, JSON lines out):
  in : repeated frames of  u32 big-endian byte count N, then N bytes of 16 kHz mono s16le PCM
  out: one JSON line per frame: {"text": "..."} ("" = no speech) or {"error": "..."}
Bad frame (odd or zero length, > MAX_BYTES): odd/zero gives {"error"} and the loop goes on; too big gives
{"error"} and exit 1 (the stream cannot be resynced). EOF on stdin = clean exit 0.
The model loads on the first frame, from the local cache only. A missing model gives
{"error":"model not found, run voice/setup.sh"}. Logs go to stderr and never hold transcript text or audio.

Usage: python server.py [--cpu] [--model large-v3] [--langs en,ru] [--stub-text TEXT (tests)]
"""

import argparse
import importlib.util
import json
import logging
import os
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # also under python -I

MAX_BYTES = 4 * 1024 * 1024  # ~2 min of 16 kHz s16


def read_exact(f, n: int) -> bytes | None:
    buf = b""
    while len(buf) < n:
        chunk = f.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def handle(pcm: bytes, transcriber, trim) -> dict:
    """One frame to one reply. `trim(audio) -> (audio, speech_s)`; empty audio means no speech."""
    import numpy as np
    if not pcm or len(pcm) % 2:
        return {"error": "bad frame: need a non-empty even number of bytes (s16le)"}
    audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
    audio, speech = trim(audio)
    if not len(audio):
        return {"text": ""}
    return {"text": transcriber.transcribe(audio, speech)}


class _Stub:
    def __init__(self, text):
        self.text = text

    def transcribe(self, audio, voiced=None):
        return self.text


def main():
    # Replies go to a private copy of the real stdout; fd 1 and sys.stdout point at stderr so library prints cannot corrupt the protocol.
    out = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--model", default=os.environ.get("JARVIS_VOICE_MODEL") or None, help="default large-v3 (CUDA float16); with --cpu large-v3-turbo int8")
    ap.add_argument("--langs", default=os.environ.get("JARVIS_VOICE_LANGS", "en,ru"))
    ap.add_argument("--stub-text", help="tests: skip the model and answer with this text for clips with speech")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="voice %(levelname)s %(message)s")
    if importlib.util.find_spec("faster_whisper") is None:
        sys.exit("voice sidecar: faster_whisper is not installed for this python; run voice/setup.sh "
                 "and set JARVIS_VOICE_PYTHON=voice/.venv/bin/python")
    import stt
    try:
        from faster_whisper.tokenizer import _LANGUAGE_CODES  # private: skip the check if a release moves it
    except ImportError:
        _LANGUAGE_CODES = None
    langs = tuple(l.strip() for l in args.langs.split(",") if l.strip())
    bad = [l for l in langs if _LANGUAGE_CODES is not None and l not in _LANGUAGE_CODES]
    if not langs or bad:
        sys.exit(f"voice sidecar: bad --langs {args.langs!r}: {', '.join(bad) or 'empty'} is not a Whisper language code")

    def reply(obj):
        out.write(json.dumps(obj, ensure_ascii=False).encode() + b"\n")
        out.flush()

    tr = _Stub(args.stub_text) if args.stub_text is not None else None
    inp = sys.stdin.buffer
    while (head := read_exact(inp, 4)) is not None:
        (n,) = struct.unpack(">I", head)
        if n > MAX_BYTES:
            reply({"error": f"frame too big: {n} bytes, max {MAX_BYTES}"})
            sys.exit(1)
        pcm = read_exact(inp, n)
        if pcm is None:
            break
        try:
            if tr is None and n and not n % 2:
                tr = stt.Transcriber(args.model or (stt.CPU_FALLBACK if args.cpu else stt.MODEL),
                                     "cpu" if args.cpu else "cuda", languages=langs)
            reply(handle(pcm, tr, stt.trim_speech))
        except stt.ModelNotFound:
            reply({"error": "model not found, run voice/setup.sh"})
        except Exception as e:  # keep the sidecar alive for the next clip; message holds no audio or text
            logging.error("transcribe failed: %s: %s", type(e).__name__, e)
            reply({"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
