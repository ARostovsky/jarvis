import json
import re
import struct
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

pytest.importorskip("faster_whisper")
sys.path.insert(0, str(Path(__file__).parent))
import stt  # noqa: E402
import server  # noqa: E402

SERVER = str(Path(__file__).parent / "server.py")


def seg(text, nsp=0.0):
    return SimpleNamespace(text=text, no_speech_prob=nsp)


def test_filter_drops_artifacts_keeps_speech():
    f = stt.ArtifactFilter()
    assert f.reason(seg("Субтитры сделал DimaTorzok"), False, 5) == "drop"
    assert f.reason(seg("Thanks for watching!"), False, 5) == "drop"
    assert f.reason(seg("Открой файл server.ts"), True, 5) is None
    assert f.reason(seg("Thank you"), True, 0.3) == "doubt"
    assert f.reason(seg("Thank you"), True, 5) is None


def test_normalize():
    assert stt.normalize("Ёлка, ЁЛКА!") == "елка елка"


def test_handle_gate_and_garbage():
    fake_tr = SimpleNamespace(transcribe=lambda a, v: "hello")
    assert server.handle(b"", fake_tr, None)["error"]
    assert server.handle(b"\x00\x00\x00", fake_tr, None)["error"]
    assert server.handle(bytes(3200), fake_tr, lambda a: (a[:0], 0.0)) == {"text": ""}
    assert server.handle(bytes(3200), fake_tr, lambda a: (a, 1.0)) == {"text": "hello"}


def run(frames: list[bytes], *extra):
    data = b"".join(struct.pack(">I", len(f)) + f for f in frames)
    p = subprocess.run([sys.executable, SERVER, "--stub-text", "stub", *extra], input=data,
                       capture_output=True, timeout=60)
    return p, [json.loads(line) for line in p.stdout.splitlines()]


def test_protocol_one_reply_per_frame():
    p, out = run([bytes(32000), b"\x01", bytes(16000)])  # silence, odd length, silence
    assert p.returncode == 0
    assert out[0] == {"text": ""}
    assert "error" in out[1]
    assert out[2] == {"text": ""}
    assert len(out) == 3


def test_oversize_frame_exits_with_error():
    p = subprocess.run([sys.executable, SERVER, "--stub-text", "x"], input=struct.pack(">I", 2**31),
                       capture_output=True, timeout=60)
    assert p.returncode == 1
    assert "error" in json.loads(p.stdout)


def test_cuda_context_lost_falls_back_to_cpu(monkeypatch):
    import faster_whisper
    cpu_model = SimpleNamespace(transcribe=lambda *a, **k: ([seg("hello")], SimpleNamespace(language="en")))
    cpu_args = {}

    def fake_whisper(name, **kw):
        cpu_args.update(name=name, **kw)
        return cpu_model

    def broken(*a, **k):
        raise RuntimeError("CUDA failed: illegal memory access")

    monkeypatch.setattr(faster_whisper, "WhisperModel", fake_whisper)
    monkeypatch.setattr(stt, "_park", lambda m: None)
    tr = object.__new__(stt.Transcriber)
    tr.__dict__.update(_model=SimpleNamespace(transcribe=broken), _cpu=False, _gpu_dead=False, _clock=lambda: 0.0,
                       _reload_after=0.0, _cpu_fallback=stt.CPU_FALLBACK, _load=None, beam_size=5, prompt="")
    segs, _ = tr._run(None, "en")
    assert segs[0].text == "hello"
    assert tr._cpu and tr._gpu_dead and tr.beam_size == 1
    assert cpu_args["name"] == "large-v3-turbo" and cpu_args["device"] == "cpu" and cpu_args["compute_type"] == "int8"


def test_defaults():
    assert stt.MODEL == "large-v3" and stt.CPU_FALLBACK == "large-v3-turbo" and stt.GPU_FREE_NEEDED_MIB == 4500


def test_library_stdout_does_not_shift_replies():
    # A stub transcriber that prints to stdout, as a chatty library would: replies must stay one JSON line per frame.
    code = ("import sys; sys.argv=['server.py', '--stub-text', 'x']; sys.path.insert(0, %r)\n"
            "import server, stt\n"
            "stt.trim_speech = lambda a: (a, 1.0)\n"
            "def noisy(self, audio, voiced=None):\n"
            "    print('junk from a library'); sys.stdout.write('more junk'); return 'ok'\n"
            "server._Stub.transcribe = noisy\n"
            "server.main()\n") % str(Path(SERVER).parent)
    data = b"".join(struct.pack(">I", len(f)) + f for f in [bytes(3200)] * 3)
    p = subprocess.run([sys.executable, "-c", code], input=data, capture_output=True, timeout=60)
    assert p.returncode == 0
    assert [json.loads(line) for line in p.stdout.splitlines()] == [{"text": "ok"}] * 3
    assert b"junk from a library" in p.stderr


def test_bad_langs_exit_1():
    for langs in ("en,xx", ",,"):
        p = subprocess.run([sys.executable, SERVER, "--stub-text", "x", "--langs", langs], input=b"", capture_output=True, timeout=60)
        assert p.returncode == 1 and p.stdout == b""
    p, out = run([bytes(3200)], "--langs", " en , ru,")
    assert p.returncode == 0 and out == [{"text": ""}]


def test_vad_measures_speech_without_padding(monkeypatch):
    import faster_whisper.vad as vad
    seen = {}

    def spans(audio, opts):
        seen["pad"] = opts.speech_pad_ms
        return [{"start": 16000, "end": 16000 + 8000}]  # 0.5 s of speech after 1 s of silence

    monkeypatch.setattr(vad, "get_speech_timestamps", spans)
    audio, speech = stt.trim_speech(__import__("numpy").zeros(16000 * 3, "float32"))
    assert seen["pad"] == 0
    assert speech == 0.5  # below DOUBT_VOICED_S: the short-voice check can fire
    assert len(audio) == 8000 + 2 * int(stt.VAD_PAD_S * 16000)  # padding is added by hand


def test_no_usable_gpu_loads_cpu_fallback(monkeypatch):
    import faster_whisper
    loads = []
    ok = SimpleNamespace(transcribe=lambda *a, **k: ([seg("hi")], SimpleNamespace(language="en")))

    def fake_whisper(name, **kw):
        loads.append((name, kw["device"]))
        if kw["device"] == "cuda":
            raise RuntimeError("CUDA failed with error invalid device ordinal")
        return ok

    monkeypatch.setattr(faster_whisper, "WhisperModel", fake_whisper)
    monkeypatch.setattr(stt, "_preload_cuda12", lambda: None)
    monkeypatch.setattr(stt, "wait_for_gpu_memory", lambda: None)
    tr = stt.Transcriber("large-v3", "cuda", languages=("en",))
    assert loads[:2] == [("large-v3", "cuda"), (stt.CPU_FALLBACK, "cpu")]
    assert tr._cpu and tr.beam_size == 1


def test_missing_model_matches_on_exception_name_only():
    class LocalEntryNotFoundError(Exception):
        pass
    assert stt._is_missing(LocalEntryNotFoundError("x"))
    assert not stt._is_missing(RuntimeError("CUDA not found"))
    assert not stt._is_missing(ValueError("cached tensor snapshot"))


def test_smi_queries_gpu_zero_only():
    calls = []

    def run(cmd, **kw):
        calls.append(cmd)
        return SimpleNamespace(stdout="8000\n")

    stt.wait_for_gpu_memory(needed=1, run=run)
    assert calls[0][:3] == ["nvidia-smi", "-i", "0"]


def _cuda_fails(monkeypatch, message, cpu_ok=True):
    import faster_whisper
    loads = []
    ok = SimpleNamespace(transcribe=lambda *a, **k: ([seg("hi")], SimpleNamespace(language="en")))

    def fake_whisper(name, **kw):
        loads.append(kw["device"])
        if kw["device"] == "cuda":
            raise RuntimeError(message)
        if not cpu_ok:
            raise OSError("not in the cache")
        return ok

    monkeypatch.setattr(faster_whisper, "WhisperModel", fake_whisper)
    monkeypatch.setattr(stt, "_preload_cuda12", lambda: None)
    monkeypatch.setattr(stt, "wait_for_gpu_memory", lambda: None)
    return loads


def test_transient_oom_at_load_raises_for_a_retry(monkeypatch):
    loads = _cuda_fails(monkeypatch, "CUDA failed with error out of memory")
    with pytest.raises(RuntimeError, match="out of memory"):
        stt.Transcriber("large-v3", "cuda")
    assert loads == ["cuda"]  # no CPU load: the next request retries the GPU


def test_missing_cublas_falls_back_to_cpu(monkeypatch):
    loads = _cuda_fails(monkeypatch, "Library libcublas.so.12 is not found or cannot be loaded")
    tr = stt.Transcriber("large-v3", "cuda", languages=("en",))
    assert loads == ["cuda", "cpu"] and tr._cpu


def test_no_gpu_and_no_cpu_model_names_the_fix(monkeypatch):
    _cuda_fails(monkeypatch, "CUDA failed with error no CUDA-capable device is detected", cpu_ok=False)
    with pytest.raises(RuntimeError) as e:
        stt.Transcriber("large-v3", "cuda")
    assert "JARVIS_VOICE=cpu" in str(e.value) and "setup.sh" in str(e.value) and "context lost" not in str(e.value)


def test_cpu_fallback_is_tried_once(monkeypatch):
    import faster_whisper
    loads = []

    def fake_whisper(name, **kw):
        loads.append(kw["device"])
        if kw["device"] == "cpu":
            raise OSError("not in the cache")
        return SimpleNamespace(transcribe=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("CUDA failed: illegal memory access")))

    monkeypatch.setattr(faster_whisper, "WhisperModel", fake_whisper)
    monkeypatch.setattr(stt, "_preload_cuda12", lambda: None)
    monkeypatch.setattr(stt, "wait_for_gpu_memory", lambda: None)
    monkeypatch.setattr(stt, "_park", lambda m: None)
    with pytest.raises(RuntimeError):
        stt.Transcriber("large-v3", "cuda")
    assert loads.count("cpu") == 1


def test_langs_check_skipped_when_private_import_fails():
    code = ("import sys, types; sys.argv=['server.py', '--stub-text', 'x', '--langs', 'zz']; sys.path.insert(0, %r)\n"
            "import faster_whisper.tokenizer as t; del t._LANGUAGE_CODES\n"
            "import server; server.main()\n") % str(Path(SERVER).parent)
    p = subprocess.run([sys.executable, "-c", code], input=b"", capture_output=True, timeout=60)
    assert p.returncode == 0


def fake_transcriber(texts, prompt):
    seen = {}

    def transcribe(audio, **kw):
        seen.update(kw)
        segs = [SimpleNamespace(text=t, no_speech_prob=0.0, avg_logprob=-0.2, compression_ratio=1.0) for t in texts]
        return segs, SimpleNamespace(language="en", all_language_probs=None)

    tr = object.__new__(stt.Transcriber)
    tr.__dict__.update(_model=SimpleNamespace(transcribe=transcribe), _cpu=False, _gpu_dead=False, languages=("en", "ru"),
                       beam_size=5, artifacts=stt.ArtifactFilter(), prompt=prompt)
    return tr, seen


def test_prompt_from_env(monkeypatch):
    monkeypatch.delenv("JARVIS_VOICE_PROMPT", raising=False)
    assert stt.prompt_from_env() == stt.DEFAULT_PROMPT
    monkeypatch.setenv("JARVIS_VOICE_PROMPT", "")
    assert stt.prompt_from_env() == ""
    monkeypatch.setenv("JARVIS_VOICE_PROMPT", " Foo, bar ")
    assert stt.prompt_from_env() == "Foo, bar"


def test_prompt_is_passed_to_whisper_unless_empty():
    tr, seen = fake_transcriber(["open server.ts"], "Jarvis, Kafka")
    assert tr.transcribe(np.zeros(16000, np.float32)) == "open server.ts"
    assert seen["initial_prompt"] == "Jarvis, Kafka"
    tr, seen = fake_transcriber(["open server.ts"], "")
    tr.transcribe(np.zeros(16000, np.float32))
    assert seen["initial_prompt"] is None


def test_default_prompt_is_a_term_list_without_a_sentence():
    assert not re.search(r"[.!?]", stt.DEFAULT_PROMPT)
    assert not re.search(r"[а-яё]", stt.DEFAULT_PROMPT.casefold())  # no Russian imperative either


def test_prompt_echo_is_dropped_but_real_speech_survives():
    p = stt.DEFAULT_PROMPT
    audio = np.zeros(16000, np.float32)
    assert fake_transcriber([p], p)[0].transcribe(audio) == ""
    assert fake_transcriber([p[:50], p[50:]], p)[0].transcribe(audio) == ""  # echoed across two segments
    assert fake_transcriber(["git diff, pull request, commit, branch."], p)[0].transcribe(audio) == ""  # the tail
    assert fake_transcriber(["Pull request, commit"], p)[0].transcribe(audio) == ""  # a run of terms
    assert fake_transcriber(["npm"], p)[0].transcribe(audio) == "npm"
    assert fake_transcriber(["git diff"], p)[0].transcribe(audio) == "git diff"
    assert fake_transcriber(["npm test"], p)[0].transcribe(audio) == "npm test"
    assert fake_transcriber(["Покажи git diff"], p)[0].transcribe(audio) == "Покажи git diff"
    assert fake_transcriber(["Jarvis, Kafka."], "Jarvis, Kafka")[0].transcribe(audio) == ""  # the whole short prompt
    assert fake_transcriber(["npm test"], "Jarvis, Kafka")[0].transcribe(audio) == "npm test"  # a short prompt drops no real speech
    assert fake_transcriber(["Kafka"], "Jarvis, Kafka")[0].transcribe(audio) == "Kafka"
    assert fake_transcriber([p], "")[0].transcribe(audio) == p  # guard is off with the prompt


def test_decode_keeps_timestamps_so_a_window_that_ends_early_loses_no_speech():
    tr, seen = fake_transcriber(["hello"], "")
    tr.transcribe(np.zeros(16000, np.float32))
    assert seen["without_timestamps"] is False and seen["condition_on_previous_text"] is False


def test_long_clip_segments_join_in_order_and_a_bad_one_is_logged_without_text(caplog):
    # a 47 s clip decoded with timestamps: segments end mid-window and the next one starts there, across the 30 s boundary
    texts = ["Так, ну что ж.", "Исключено по логам.", "loop loop loop", "34,7 секунд.", "работала на gpu"]
    tr, _ = fake_transcriber(texts, "")
    bad = tr._model.transcribe

    def transcribe(audio, **kw):
        segs, info = bad(audio, **kw)
        segs[2].compression_ratio = 3.1
        return segs, info

    tr._model = SimpleNamespace(transcribe=transcribe)
    with caplog.at_level("INFO", logger="stt"):
        assert tr.transcribe(np.zeros(47 * 16000, np.float32)) == "Так, ну что ж. Исключено по логам. 34,7 секунд. работала на gpu"
    assert "compression 3.10, no_speech 0.00, logprob -0.20" in caplog.text
    assert "loop" not in caplog.text
