"""Speech-to-text core for the Jarvis voice sidecar.

Adapted from an earlier internal speech-to-text implementation (ArtifactFilter, normalize, wait_for_gpu_memory,
_preload_cuda12, CUDA error recovery with CPU fallback, en/ru language pick). Its streaming chunker is not
used and nothing is imported from it. Keep fixes in sync by hand.

Audio stays in memory. Nothing here logs transcript text or writes audio to disk. The model is never
downloaded: a model missing from the local HF cache raises ModelNotFound.
"""

import ctypes
import difflib
import gc
import importlib.util
import logging
import os
import re
import subprocess
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import numpy as np

RATE = 16000
MODEL = "large-v3"
CPU_FALLBACK = "large-v3-turbo"  # int8 on the CPU, forced or after a lost CUDA context
BEAM_SIZE = 5
OOM_BACKOFF = 0.5  # seconds before retrying after a CUDA out-of-memory
OOM_COOLDOWN = 10.0  # seconds after a model reload before the next one is tried
CPU_THREADS = 6  # leave the rest of the machine to the user
GPU_FREE_NEEDED_MIB = 4500  # large-v3 float16 beam 5 peaks near 4.1 GB
GPU_WAIT_S = 20.0
LANGUAGES = ("en", "ru")
MIN_SPEECH_S = 0.25
NO_SPEECH_MAX = 0.6
LOGPROB_MIN = -1.0
COMPRESSION_MAX = 2.4
# Whisper hallucinations from subtitle credits in its training data. Matched against the whole normalized
# segment; a trailing "*" matches a prefix.
DROP_PHRASES = ("продолжение следует", "спасибо за просмотр", "субтитры сделал*", "субтитры делал*",
                "субтитры создавал*", "редактор субтитров*", "thanks for watching", "thank you for watching")
# also real speech: dropped only when the segment is the whole clip and Whisper doubts it or the voice is short
DOUBT_PHRASES = ("thank you", "спасибо", "you", "до новых встреч")
DOUBT_NO_SPEECH = 0.3
DOUBT_VOICED_S = 0.6
# Bias for names and terms Whisper mishears. JARVIS_VOICE_PROMPT overrides it; an empty value turns it off.
# A plain list of terms, never a sentence: Whisper echoes parts of the prompt, and an echoed command would be sent to an agent.
DEFAULT_PROMPT = "Jarvis, arbiter, agent, workspace, Kafka, npm, git diff, pull request, commit, branch"
PROMPT_ECHO = 0.8  # similarity at which a result counts as the prompt echoed back (Whisper does that on noise)
VAD_PAD_S = 0.4  # context kept around the speech, as faster-whisper pads by default

log = logging.getLogger(__name__)


class ModelNotFound(RuntimeError):
    """The model is not in the local cache."""


def _preload_cuda12():
    """ctranslate2 needs CUDA 12 cuBLAS/cuDNN; a CUDA 13 host needs the pip copies loaded first."""
    spec = importlib.util.find_spec("nvidia")
    loaded = 0
    for root in spec.submodule_search_locations if spec else ():
        for name in ("cublas/lib/libcublasLt.so.12", "cublas/lib/libcublas.so.12", "cudnn/lib/libcudnn.so.9"):
            if (lib := Path(root) / name).exists():
                ctypes.CDLL(str(lib), mode=ctypes.RTLD_GLOBAL)
                loaded += 1
    if loaded < 3:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            log.warning("only %d of 3 nvidia-cublas-cu12/nvidia-cudnn-cu12 libraries found; CUDA model load may fail", loaded)


def is_cuda_error(e: BaseException) -> bool:
    msg = str(e).lower()
    return any(k in msg for k in ("cuda", "cublas", "out of memory", "invalid device", "parallel_for"))


def _is_transient(e: BaseException) -> bool:
    """Out of GPU memory: another process may free it, so the load is retried instead of giving up on the GPU."""
    msg = str(e).lower()
    return "out of memory" in msg or "cudaerrormemoryallocation" in msg


def is_context_lost(e: BaseException) -> bool:
    """The CUDA context is dead (a plain OOM is not)."""
    msg = str(e).lower()
    if "out of memory" in msg or "cudaerrormemoryallocation" in msg:
        return False
    return any(k in msg for k in (
        "invalid device", "cudaerrorinvaliddevice", "illegal memory access", "cudaerrorillegaladdress",
        "illegal instruction", "misaligned address", "launch failure", "cublas_status_execution_failed"))


_PARKED: list = []  # models whose CUDA context died: their destructor may abort the process, so they are never freed


def _park(model):
    _PARKED.append(model)
    ctypes.pythonapi.Py_IncRef(ctypes.py_object(model))


class GpuBusy(RuntimeError):
    """Not enough free GPU memory to load the model; the message names who holds it."""


def _smi(query: str, fields: str, run) -> list[list[str]] | None:
    try:  # GPU 0 only: that is the device the model loads on
        out = run(["nvidia-smi", "-i", "0", f"--query-{query}={fields}", "--format=csv,noheader,nounits"],
                  capture_output=True, text=True, timeout=10, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return [[c.strip() for c in line.split(",")] for line in out.splitlines() if line.strip()]


def wait_for_gpu_memory(needed: int = GPU_FREE_NEEDED_MIB, wait: float = GPU_WAIT_S, run=subprocess.run,
                        clock=time.monotonic, sleep=time.sleep):
    """Poll until `needed` MiB are free (without nvidia-smi: no check); raise GpuBusy after `wait` seconds."""
    deadline = clock() + wait
    while True:
        rows = _smi("gpu", "memory.free", run)
        try:
            free = min(int(r[0]) for r in rows) if rows else None
        except ValueError:
            free = None
        if free is None or free >= needed:
            return
        if clock() >= deadline:
            break
        sleep(1.0)
    apps = _smi("compute-apps", "pid,name,used_memory", run) or []
    held = ", ".join(f"pid {r[0]} {r[1]} ({r[2]} MiB)" for r in apps if len(r) == 3) or "no process listed"
    raise GpuBusy(f"only {free} MiB of GPU memory free, the model needs {needed} MiB; held by: {held}")


def normalize(text: str) -> str:
    """Casefolded words only: "Субтитры сделал DimaTorzok!" and "субтитры  сделал dimatorzok" compare equal."""
    text = unicodedata.normalize("NFKC", text).casefold().replace("ё", "е")
    return " ".join("".join(c if c.isalnum() else " " for c in text).split())


def _matches(norm: str, phrases) -> bool:
    return any(norm.startswith(p[:-1]) if p.endswith("*") else norm == p for p in phrases)


@dataclass(frozen=True)
class ArtifactFilter:
    drop: tuple[str, ...] = DROP_PHRASES
    doubt: tuple[str, ...] = DOUBT_PHRASES
    doubt_no_speech: float = DOUBT_NO_SPEECH
    doubt_voiced_s: float = DOUBT_VOICED_S

    def __post_init__(self):
        for name in ("drop", "doubt"):
            object.__setattr__(self, name, tuple(normalize(p) + "*" * p.rstrip().endswith("*")
                                                 for p in getattr(self, name) if normalize(p)))

    def reason(self, seg, alone: bool, voiced: float) -> str | None:
        """"drop" or "doubt" when the segment is a known hallucination, else None."""
        norm = normalize(seg.text)
        if _matches(norm, self.drop):
            return "drop"
        if alone and _matches(norm, self.doubt) and (seg.no_speech_prob >= self.doubt_no_speech
                                                       or voiced < self.doubt_voiced_s):
            return "doubt"
        return None


def prompt_from_env() -> str:
    return os.environ.get("JARVIS_VOICE_PROMPT", DEFAULT_PROMPT).strip()


def echoes_prompt(text: str, prompt: str) -> bool:
    """True when `text` is the prompt, or part of it, repeated as the transcript.

    Parts: a start of at least 4 words, or a run of at least 2 whole terms (the comma or sentence pieces of the prompt)
    anywhere in it, tail included. One term alone is real speech ("npm", "git diff"). A prompt shorter than 4 words
    only counts when repeated whole, so a short custom prompt never drops real speech.
    """
    a, b = normalize(text), normalize(prompt)
    if not (a and b):
        return False
    if a == b:
        return True
    if len(b.split()) < 4:
        return False
    if (len(a.split()) >= 4 and b.startswith(a)) or difflib.SequenceMatcher(None, a, b).ratio() >= PROMPT_ECHO:
        return True
    terms = [t for t in (normalize(x) for x in re.split(r"[.,;:!?\n]+", prompt)) if t]
    return any(" ".join(terms[i:j]) == a for i in range(len(terms)) for j in range(i + 2, len(terms) + 1))


def trim_speech(audio: np.ndarray) -> tuple[np.ndarray, float]:
    """Silero VAD gate (bundled with faster-whisper). Returns (audio from first to last speech plus VAD_PAD_S of
    context each side, speech seconds without that padding); speech under MIN_SPEECH_S gives an empty array."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    # speech_pad_ms=0: the padding would count as speech and the short-voice hallucination check could never fire
    spans = get_speech_timestamps(audio, VadOptions(min_speech_duration_ms=int(MIN_SPEECH_S * 1000), speech_pad_ms=0))
    speech = sum(s["end"] - s["start"] for s in spans) / RATE
    if not spans or speech < MIN_SPEECH_S:
        return audio[:0], 0.0
    pad = int(VAD_PAD_S * RATE)
    return audio[max(0, spans[0]["start"] - pad):spans[-1]["end"] + pad], speech


class Transcriber:
    """faster-whisper wrapper. Loads the model on construction, from the local cache only."""

    def __init__(self, model: str = MODEL, device: str = "cuda", beam_size: int = BEAM_SIZE,
                 languages: tuple[str, ...] = LANGUAGES, cpu_fallback: str | None = CPU_FALLBACK,
                 artifacts: ArtifactFilter = ArtifactFilter(), prompt: str | None = None):
        from faster_whisper import WhisperModel
        self.languages, self.artifacts, self.beam_size = languages, artifacts, beam_size
        self.prompt = prompt_from_env() if prompt is None else prompt
        self._cpu_fallback = cpu_fallback
        self._clock, self._reload_after = time.monotonic, 0.0
        self._cpu = device == "cpu"
        self._gpu_dead = False
        self._model = None
        if self._cpu:
            self._load = lambda: WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS,
                                              local_files_only=True)
            self.beam_size = 1
        else:
            _preload_cuda12()
            wait_for_gpu_memory()
            self._load = lambda: WhisperModel(model, device="cuda", compute_type="float16", local_files_only=True)
        warm = np.zeros(RATE, np.float32)
        try:
            self._model = self._load()
            self._run(warm, "en")  # first call pays for CUDA kernel setup
        except Exception as e:
            if self._model is None and _is_missing(e):
                raise ModelNotFound(model) from None
            if self._cpu or self._gpu_dead or _is_transient(e):
                raise  # out of memory raises so the next request retries the load
            self._to_cpu(f"{type(e).__name__}: {e}")  # any other failure: no usable GPU, serve from the CPU instead of failing every request
            self._run(warm, "en")

    def close(self):
        self._model = None
        gc.collect()

    def _run(self, audio: np.ndarray, language: str | None):
        if self._model is None:  # an earlier reload failed
            self._fresh_model()
        try:
            return self._decode(audio, language, self.beam_size)
        except RuntimeError as e:
            if not is_cuda_error(e) or self._cpu:
                raise
            lost, msg = is_context_lost(e), str(e)  # keep no exception: its traceback would pin the model
            if not lost and self._clock() < self._reload_after:
                raise
        if lost:
            self._to_cpu(msg)
            return self._decode(audio, language, self.beam_size)
        log.warning("stt CUDA error on %.2fs audio, retrying with beam 1: %s", len(audio) / RATE, msg)
        gc.collect()
        time.sleep(OOM_BACKOFF)
        try:
            return self._decode(audio, language, 1)
        except RuntimeError as e:
            if not is_cuda_error(e):
                raise
            lost, msg = is_context_lost(e), str(e)
        if lost:
            self._to_cpu(msg)
            return self._decode(audio, language, self.beam_size)
        log.warning("stt CUDA error again, reloading the model: %s", msg)
        self._model = None
        gc.collect()
        time.sleep(OOM_BACKOFF * 2)
        self._fresh_model()
        try:
            return self._decode(audio, language, 1)
        except RuntimeError as e:
            if not is_context_lost(e) or self._cpu:
                raise
            msg = str(e)
        self._to_cpu(msg)
        return self._decode(audio, language, self.beam_size)

    def _fresh_model(self):
        if self._gpu_dead:
            self._cooldown()
            self._to_cpu("CUDA context lost earlier")
        else:
            self._cooldown()
            self._model = self._load()

    def _cooldown(self):
        if self._clock() < self._reload_after:
            raise RuntimeError("CUDA model reload on cooldown")
        self._reload_after = self._clock() + OOM_COOLDOWN

    def _to_cpu(self, cause: str):
        """Last resort: a CUDA context that cannot be rebuilt in this process; sticky until restart."""
        self._gpu_dead = True
        if self._model is not None:
            _park(self._model)
            self._model = None
        if self._cpu_fallback is None or self._cpu:
            raise RuntimeError(f"the GPU is unusable and there is no CPU fallback: {cause}")
        name = self._cpu_fallback
        try:
            from faster_whisper import WhisperModel
            model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS,
                                 local_files_only=True)
        except Exception as e:
            self._reload_after = self._clock() + OOM_COOLDOWN
            log.error("stt GPU unusable (%s) and the CPU fallback %s failed to load: %s", cause, name, e)
            raise RuntimeError(f"the GPU is unusable and the CPU model {name} is not available: run voice/setup.sh or set JARVIS_VOICE=cpu") from None
        log.warning("stt GPU unusable (%s): switching to %s int8 on the CPU until restart", cause, name)
        self._load = None
        self._model, self._cpu, self.beam_size = model, True, 1

    def _decode(self, audio: np.ndarray, language: str | None, beam_size: int):
        segs, info = self._model.transcribe(
            audio, language=language, beam_size=beam_size, temperature=0.0, vad_filter=False,
            # timestamps on: without them a window whose text ends early skips to the next 30 s window and loses the speech in between
            condition_on_previous_text=False, without_timestamps=False, initial_prompt=self.prompt or None)
        return list(segs), info

    def transcribe(self, audio: np.ndarray, voiced: float | None = None) -> str:
        """`voiced`: seconds of speech the VAD found in `audio` (default: all of it)."""
        segs, info = self._run(audio, None)
        if info.language not in self.languages:
            # Whisper sometimes labels Russian as Ukrainian/Bulgarian etc.: pick the best allowed language
            probs = dict(info.all_language_probs or [])
            best = max(self.languages, key=lambda lang: probs.get(lang, 0.0))
            try:
                segs, info = self._run(audio, best)
            except RuntimeError as e:
                if not is_cuda_error(e):
                    raise
                log.warning("stt second decode failed (%s): keeping the first one", e)
        good = []
        for s in segs:
            if (s.no_speech_prob < NO_SPEECH_MAX or s.avg_logprob > LOGPROB_MIN) and s.compression_ratio <= COMPRESSION_MAX:
                if s.text.strip():
                    good.append(s)
            else:
                log.info("stt dropped a segment: compression %.2f, no_speech %.2f, logprob %.2f", s.compression_ratio, s.no_speech_prob, s.avg_logprob)
        segs = good
        voiced = len(audio) / RATE if voiced is None else voiced
        if self.prompt and echoes_prompt(" ".join(s.text for s in segs), self.prompt):  # echoed over several segments
            log.info("stt dropped the prompt echoed back, voiced %.2fs", voiced)
            return ""
        kept = []
        for s in segs:
            if self.prompt and echoes_prompt(s.text, self.prompt):
                log.info("stt dropped the prompt echoed back, voiced %.2fs", voiced)
            elif why := self.artifacts.reason(s, len(segs) == 1, voiced):
                log.info("stt dropped a hallucination (%s list): no_speech %.2f, voiced %.2fs", why, s.no_speech_prob, voiced)
            else:
                kept.append(s.text.strip())
        return " ".join(kept)


def _is_missing(e: Exception) -> bool:
    """A cache miss with local_files_only: faster-whisper raises LocalEntryNotFoundError."""
    return "notfound" in type(e).__name__.lower()
