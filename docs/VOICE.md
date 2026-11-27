# Voice input

Voice input is an optional push-to-talk feature. A mic button next to SEND records the microphone on the machine that runs Jarvis, a local Whisper model (faster-whisper, in a Python sidecar) turns the audio into text, and the text goes to the selected agent like a typed message. Audio stays on your machine.

This page covers use, setup, configuration and internals. The user guide ([GUIDE.md](GUIDE.md#voice-input-optional)) has a shorter walk-through; this page is the reference for voice and wins when they differ.

## Contents

- [How it works](#how-it-works)
- [Setup](#setup)
- [Using it](#using-it)
- [Mute while recording](#mute-while-recording)
- [Vocabulary](#vocabulary)
- [Configuration](#configuration)
- [Server endpoints](#server-endpoints)
- [Files](#files)
- [Privacy](#privacy)
- [Known limits](#known-limits)

## How it works

1. The UI posts `/voice/start`. The server spawns `pw-record --raw --rate 16000 --channels 1 --format s16 -` (the default source, no `--target`; `--raw` because the output would otherwise start with an AU header) and keeps the samples in memory. The browser never touches the microphone, so it asks for no permission.
2. While the button is held, the UI polls `/voice/level` every 100 ms for the meter. Each poll also renews a lease.
3. On release the UI posts `/voice/stop`. The server ends the capture and writes the audio to the sidecar as one frame. The sidecar cuts the silence (Silero VAD), runs Whisper and filters likely hallucinations. The server returns `{text}`.
4. The UI sends the text to the agent that was selected at press time (`POST /send`), or inserts it into the input box (`JARVIS_VOICE_AUTOSEND=0`).

Voice is off unless `JARVIS_VOICE` is set. Then `src/voice.ts` is not even loaded, there are no `/voice` routes and no process. The server calls `listen` first and runs the preflight afterwards, so a slow preflight never delays the start; the mic button appears a moment later (reload the page if it is missing right after a start).

The sidecar (`voice/server.py`) starts on the first recording, handles one job at a time and exits after `JARVIS_VOICE_IDLE_S` without work (this frees the VRAM). A crash or a job over `JARVIS_VOICE_TIMEOUT_S` fails that one recording; the next one starts a fresh sidecar. Protocol: on stdin, frames of a 4-byte big-endian length and that many bytes of 16 kHz mono s16le PCM; on stdout, one JSON line per frame (`{"text"}`, `""` meaning no speech, or `{"error"}`); stderr is for logs (never audio or text); EOF on stdin ends it. A frame over 4 MiB (about 131 s) is answered with an error and the sidecar exits.

## Setup

1. Linux with PipeWire and `pw-record` (package `pipewire`, or `pipewire-bin` / `pipewire-utils`). Jarvis records the default input of the sound server: the one `wpctl status` marks with `*` under Sources. A GPU with about 4 GB of free VRAM is needed for the default model; without one use `cpu`.
2. Run `voice/setup.sh`. It creates `voice/.venv`, installs `faster-whisper`, `numpy` and the CUDA 12 libraries, and downloads `large-v3` (or `$JARVIS_VOICE_MODEL`) and `large-v3-turbo`. This is the only network step; the sidecar never downloads. `npm ci` does not touch `voice/`. To use another Python, set `JARVIS_VOICE_PYTHON` to one that has `faster-whisper`.
3. Start Jarvis with `JARVIS_VOICE=1` (`cpu` forces the CPU). To have it on after every restart, put `JARVIS_VOICE=1` on a line in `$XDG_CONFIG_HOME/jarvis/env` (`~/.config/jarvis/env`): Jarvis reads that optional file of `KEY=value` lines at start. A variable in the environment wins over the file. `JARVIS_ENV_FILE` points at another file.

Preflight: `pw-record` must be in `PATH`, and `<python> -I -c "import faster_whisper"` must work (checked once). If a check fails, Jarvis starts as usual, logs one `voice disabled: ...` line to `server.log` (for example `voice disabled: pw-record not found`) and shows no mic button.

Models: `large-v3` on CUDA (float16, beam 5, about 4 GB of VRAM at peak), loaded on the first recording and unloaded after the idle time. Before loading, the sidecar waits up to 20 s for 4500 MiB of free memory on GPU 0 (when `nvidia-smi` exists) and then fails with who holds it. On the CPU, `large-v3-turbo` (int8, beam 1) is used; it is slower than real time on a short clip. After a lost CUDA context or an unusable GPU, the sidecar switches to that CPU model until it restarts. `JARVIS_VOICE_MODEL` picks another model.

## Using it

Hold the mic button, or hold `Ctrl+Space` in the input box, or `Alt+V` anywhere (not while a dialog is open), and release to transcribe and send. Recording starts when Jarvis has the first audio from `pw-record`, about a tenth of a second after the press: wait for the red button before the first word. The button turns red with a level meter, and a strip replaces SEND (`● 0:07 release sends`; the hint is cut with an ellipsis in a narrow panel, the timer never; the typed draft keeps at least 28% of the row).

**Cancel** (nothing is sent or transcribed): release within 0.4 s of the press (a tap; the toast says `Hold to talk`), press `Esc`, or drag the pointer more than 60 px away from the button and release there (the button turns grey and struck through, the strip says `release cancels`; drag back to keep recording). With autosend, switching to another window also cancels.

**Transcribing:** the strip says `transcribing… Esc discards` and the button ignores presses. `Esc` then drops the text when it arrives; the transcription itself still runs to the end.

**Autosend (default).** The text goes to the agent selected at press time, not the one selected at release. Text already in the input box goes with it, as one message: the draft, a blank line, the transcript; the box is cleared like after SEND, except for text typed after the release (it stays, and the draft part that was sent is cut from it). If the recording is cancelled, the transcription fails or the send fails, the draft stays in the box. A failed send puts the transcript into that agent's draft.

**`JARVIS_VOICE_AUTOSEND=0`.** The text is inserted into the input box at the caret and is never sent by itself. Losing the window then counts as a release, not a cancel.

**Guard.** Voice follows the typing guard: for an agent that works for a lead the input is read-only, so recording does not start until you double-click the input to unlock it. The mic button is greyed out like SEND while the input is read-only. If the agent is guarded when the text arrives, it goes into the draft instead.

**Messages.** `No speech recognized` (empty text; a muted microphone records silence, check `wpctl status`), `Microphone unavailable: <reason>` (start failed, for example `pw-record not found`), `voice failed: <reason>` (transcription failed), `Recording stopped` (the server ended the recording: lease expired, restart, another tab).

**Limits on a recording.** It stops by itself after `JARVIS_VOICE_MAX_S` (60 s; the audio so far is still transcribed). The recorder never outlives its use: it also dies on release, `Esc`, when the page stops polling for `JARVIS_VOICE_LEASE_S` (4 s: tab closed, crash) and when Jarvis exits. Only the tab that started a recording can stop or cancel it. There is one recording at a time.

## Mute while recording

By default Jarvis mutes the default output (sink) while it records, so speakers do not bleed into the microphone. It needs `wpctl`; without it Jarvis logs `voice: wpctl not found, the output is not muted while recording` and records anyway. `JARVIS_VOICE_MUTE_OUTPUT=0` turns the mute off (a mute left by an earlier run is still undone at start).

- The sink is resolved once, at the first mute, to its numeric id and `node.name` (`wpctl inspect @DEFAULT_AUDIO_SINK@`), and every later call targets that id, so a default sink that changes mid-recording (headset reconnect) is not unmuted by mistake. If inspect fails, nothing is muted (one log line).
- A sink the user had already muted is left alone and never unmuted.
- State is the marker file `voice-muted` in the data dir (JSON `{sink, name, holders: [{id, pid, start}]}`), shared by every Jarvis process and changed under the lock directory `voice-muted.lock` (write to a temp file, then rename; its `owner` file holds a token that only the owner may release; a dead owner or a lock older than 30 s is renamed away and taken at once). Each recorder is one holder: the first holder mutes, the last one unmutes. A holder with a dead pid, another process start time (recycled pid) or none (the old pid-only marker) is dropped.
- Unmute happens on child close, a failed start, `exit` and SIGTERM/SIGINT/SIGHUP. At start `recover()` (and each `engage()`) undoes a mute that no live holder owns, following the node name when the id is gone or taken by another node. It drops the marker only when wpctl says the node is not found; a timeout keeps it. A failed unmute keeps the marker and is retried every 2 s, up to 5 times, and by the next start or exit hook; then `voice: cannot unmute sink <id>` is logged.
- The lock is waited for without blocking the event loop (25 ms timer, up to 15 s, then it runs unlocked) except in `recover()` and the exit hooks. The `wpctl` calls are synchronous (1.5 s each, at most six under the lock), so a hanging `wpctl` can stall the server for seconds.
- By design: a mute that the user sets during a recording is undone at its end; if the marker file is deleted while two Jarvis record, the first to finish unmutes.

## Vocabulary

Whisper gets a prompt that biases it toward English names and developer terms, which it would otherwise transliterate inside Russian speech. The prompt is a plain list of terms, never a sentence: Whisper can echo the prompt, and an echoed sentence would be sent to an agent. Order, first to last:

1. The built-in list (`DEFAULT_PROMPT` in `voice/stt.py`). Its neighbours are ordered so no two form a phrase said alone ("git commit", "npm test"); a test guards that. `JARVIS_VOICE_PROMPT_DEFAULT=0` leaves it out.
2. The words of the vocabulary file `$XDG_CONFIG_HOME/jarvis/voice-vocab.txt` (`JARVIS_VOICE_VOCAB` overrides the path): one word or phrase per line, `#` lines and blank lines ignored. [`voice/voice-vocab.example.txt`](../voice/voice-vocab.example.txt) is a starting point. The sidecar checks the file's mtime before each transcription and rebuilds the prompt when it changed, so edits apply to the next recording without a restart.
3. `JARVIS_VOICE_PROMPT`, extra terms joined with `, `.

Whisper keeps only the last 223 prompt tokens (`PROMPT_TOKENS`, estimated by `est_tokens`), so the vocabulary file words are cut from their end to fit.

**By chat.** With voice on, the arbiter has the tool `voice_vocab` (`add`, `remove`, `list`). Tell Jarvis "add the word X to the voice dictionary". It writes the word as you spelled it. `src/voice-vocab.ts` skips a word that is empty, starts with `#`, contains a newline, is over 80 characters, is already there (case-insensitive) or would push the file over 8 KiB; `remove` matches case-insensitively; writes go through a temp file and rename. When the words probably exceed the prompt it returns a warning (a fixed estimate of about 150 tokens, not the exact budget). The tool and a line of the arbiter prompt exist only when `JARVIS_VOICE` is set.

**Echo filter.** `echoes_prompt` in `voice/stt.py` drops a result that equals or nearly equals the prompt, starts like it, or repeats a run of 2 or more of its terms (a prompt under 4 words only when repeated whole). Other filters: segments with a high `no_speech` probability, a low log-probability or a high compression ratio; known subtitle-credit hallucinations ("thanks for watching" and Russian equivalents); and short phrases that are also real speech ("thank you", "спасибо") when they are the whole clip and Whisper doubts them or the voiced part is short. Speech shorter than 0.25 s counts as no speech.

**Languages.** `JARVIS_VOICE_LANGS` (default `en,ru`) lists the allowed languages. If Whisper detects another one, the clip is decoded again with the best allowed language. An invalid code stops the sidecar at start.

## Configuration

All variables are optional. They can go into the env file (see [Setup](#setup)).

| Variable | Default | What it does |
|----------|---------|--------------|
| `JARVIS_VOICE` | unset (off) | `1` turns voice input on, `cpu` forces the CPU. Unset: no route, no process, `voice: false` |
| `JARVIS_VOICE_AUTOSEND` | `1` | `0` inserts the transcript into the input box instead of sending it. Reported to the UI as `voiceAutosend` |
| `JARVIS_VOICE_PYTHON` | `voice/.venv/bin/python` if it exists, else `python3` | Interpreter for the preflight and the sidecar |
| `JARVIS_VOICE_MODEL` | `large-v3` | Sidecar model (on the CPU the default is `large-v3-turbo`) |
| `JARVIS_VOICE_LANGS` | `en,ru` | Languages the sidecar picks from |
| `JARVIS_VOICE_IDLE_S` | `600` | Idle seconds before the sidecar exits (invalid values fall back) |
| `JARVIS_VOICE_TIMEOUT_S` | `120` | Seconds one job may take; then it fails, the sidecar is killed and the next job respawns it |
| `JARVIS_VOICE_MAX_S` | `60` | Recording cap in seconds; capture stops, the samples stay for `/voice/stop`. Reported to the UI as `voiceMaxS`. Keep it under about 130 s (see [Known limits](#known-limits)) |
| `JARVIS_VOICE_LEASE_S` | `4` | A recording whose `/voice/level` is not polled for this long is killed and discarded |
| `JARVIS_VOICE_MUTE_OUTPUT` | `1` | `0` does not mute the output while recording |
| `JARVIS_VOICE_PROMPT` | unset | Extra terms appended to the prompt |
| `JARVIS_VOICE_VOCAB` | `$XDG_CONFIG_HOME/jarvis/voice-vocab.txt` | Vocabulary file |
| `JARVIS_VOICE_PROMPT_DEFAULT` | `1` | `0` leaves the built-in term list out (an empty prompt when `JARVIS_VOICE_PROMPT` is unset too) |
| `JARVIS_VOICE_DEBUG_WAV` | unset (off) | Directory. **Deliberately writes your audio and its transcript to disk** (see [Privacy](#privacy)) |

Invalid or non-positive numbers in the `_S` variables fall back to the default.

Tests only (never needed in real use):

| Variable | What it does |
|----------|--------------|
| `JARVIS_VOICE_CMD` | Whole spawn command of the sidecar; skips the Python preflight (`node e2e/fake-voice.ts`) |
| `JARVIS_VOICE_CAPTURE_CMD` | Whole capture command (`node e2e/fake-capture.ts`); it must write raw 16 kHz mono s16le to stdout. Its executable is the one the preflight looks for |
| `JARVIS_VOICE_MUTE_CMD` | Command prefix standing in for `wpctl` (`node e2e/fake-mute.ts <statefile>`; `e2e/fake-wpctl.ts <dir>` behaves like the real one, with several sinks, a movable default, gone nodes and hanging calls) |

Tests and e2e run voice with `JARVIS_VOICE=1 JARVIS_VOICE_CMD="node e2e/fake-voice.ts"` and the capture stub, never real Python, models or PipeWire.

## Server endpoints

Every `/voice` POST has the same Host, Origin and content-type checks as other POSTs (403 otherwise), `/voice/level` included, because it renews the lease. The routes exist only when voice is on and its preflight passed (404 otherwise). An error carries its own status; anything without one is a 400 with the message as the body.

| Endpoint | Body | Answer |
|----------|------|--------|
| `GET /workspaces` | | adds `voice` (true only when voice is on and the preflight passed), `voiceAutosend` and `voiceMaxS` (the recording cap; the UI's auto-stop timer uses it) |
| `POST /voice/start` | `{}` | `{id}` once `pw-record` delivers audio; 409 `already recording`; 500 with the reason when `pw-record` is missing, exits (with its last stderr line) or sends no audio for 3 s |
| `POST /voice/stop` | `{id}` | `{text}` after transcribing (empty = no speech or no audio); 409 when nothing records or the id is another recording's; 400 with the sidecar's error text |
| `POST /voice/cancel` | `{id}` | 204; kills the recorder and discards the audio; 409 for another recording's id, a no-op when nothing records |
| `POST /voice/level` | `{id}` | `{recording, level}`, `level` 0 to 1 (RMS of the last 100 ms, times 4, capped at 1); `recording: false` for an unknown id, so a stale tab learns it lost its recording |

`start` returns an id that `stop`, `cancel` and `level` must pass, so a stale tab cannot touch another tab's recording. The UI chains one `level` request after each answer (100 ms apart) while held, and goes idle with the toast `Recording stopped` when `recording` is false or after three failed requests.

## Files

| Path | What it is |
|------|------------|
| `src/voice.ts` | Backend, imported by `server.ts` only when `JARVIS_VOICE` is set: `createRecorder` (capture, one recording, ids, cap, lease), `createMuter` (output mute), `createSidecar` (lazy spawn, one job at a time, idle kill, per-job timeout), `withDebugDump`, `initVoice` (preflight and wiring). The capture child also dies when Jarvis exits (`exit` hook, plus `setpriv --pdeathsig TERM` when `/usr/bin/setpriv` exists, which covers SIGKILL) |
| `src/voice-vocab.ts` | The vocabulary file and its `voice_vocab` rules (pure Node) |
| `src/server.ts` | Loads `voice.ts`, adds the `/voice` routes and the `voice*` fields of `GET /workspaces` |
| `src/agents.ts` | The `voice_vocab` MCP tool and the arbiter prompt line, both only with voice on |
| `public/index.html` | The voice block: `#mic`, `#recbar`, push-to-talk, cancel rules (`MIC_TAP_MS` 400 ms, `MIC_AWAY_PX` 60, tracked with pointer capture and `pointermove`, never `pointerleave`), meter, autosend and draft handling |
| `voice/server.py` | The sidecar loop and protocol |
| `voice/stt.py` | Model loading (GPU wait, CPU fallback), VAD trim, prompt and vocabulary, language choice, hallucination filters |
| `voice/setup.sh`, `voice/pyproject.toml` | Environment and model download; the dependency list for reference |
| `voice/test_voice.py` | Python tests of the sidecar (`pytest`) |
| `voice/voice-vocab.example.txt` | Example vocabulary file |
| `test/voice.test.ts`, `test/voice-mute.test.ts`, `test/voice-vocab.test.ts` | Unit tests of the recorder, sidecar, mute and vocabulary |
| `e2e/voice.spec.ts` | UI test against a server of its own (port `MAIN_PORT + 1000`) |
| `e2e/fake-voice.ts`, `e2e/fake-capture.ts`, `e2e/fake-mute.ts`, `e2e/fake-wpctl.ts` | Stand-ins for the sidecar (reply depends on the frame size), `pw-record` (modes `tone`, `odd`, `silent`, `exit`) and `wpctl` |

## Privacy

Audio lives in memory only. It is never written to disk and never logged to `server.log`, and neither is the transcript. The one exception is the opt-in `JARVIS_VOICE_DEBUG_WAV=<dir>`: `withDebugDump` writes each clip to `<dir>/last.wav` (16 kHz mono s16) and the text to `<dir>/last.txt`, overwriting (directory `0700`, files `0600`, written through a temp file and renamed so that a symlink at `last.wav` is replaced, not followed). The "never stored" rule holds only while it is unset. A write failure never fails the transcription.

With autosend (default) the transcript is posted to `/send` like typed text, so it lands in the event log as a user message. With `JARVIS_VOICE_AUTOSEND=0` it only goes into the input box.

## Known limits

- Linux with PipeWire only (`pw-record`, optionally `wpctl`). No macOS capture.
- The default model needs a GPU with about 4.5 GB free; the CPU fallback is slow.
- English and Russian by default; other languages need `JARVIS_VOICE_LANGS` and a model that supports them.
- One recording at a time per server, and one transcription at a time; a second tab's start gets 409.
- The sidecar refuses a frame over 4 MiB (about 131 s of audio). `JARVIS_VOICE_MAX_S` above that makes long recordings fail and restart the sidecar.
- Escaping while transcribing drops the text but does not abort the sidecar job.
- A mic muted in the sound server records silence and gives `No speech recognized`.
- The mute code calls `wpctl` synchronously; a hanging `wpctl` can stall the server for seconds. See [Mute while recording](#mute-while-recording) for the by-design cases.
- Hallucination filters are heuristics: Whisper can still produce a wrong or invented phrase on noise.
