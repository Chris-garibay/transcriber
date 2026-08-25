# Architecture

## Processes

```
renderer (React)          preload            main (Node)
  UI state                 contextBridge      storage      filesystem
  AudioWorklet  --PCM-->   window.api  -->    recorder     wav writer
  clipboard                (frozen)           queue        whisper.cpp child process
                                              verify       cleanup
```

`contextIsolation: true`, `nodeIntegration: false`. The renderer has no filesystem or Node
access; everything crosses through the preload bridge, which exposes one frozen object.

## Why these choices

**whisper.cpp as a child process, not a native addon.** A native addon means node-gyp,
`electron-rebuild`, and breakage on every Electron upgrade. A crash inside the model would also
take down the main process while audio was still only on disk. A child process gives crash
isolation, free cancellation, and identical behaviour on macOS and Windows.

**Raw PCM capture, not MediaRecorder.** The renderer opens `AudioContext({ sampleRate: 16000 })`
and taps it with an AudioWorklet, converting Float32 to Int16 and streaming to main at ~32 KB/s.
This is exactly what whisper.cpp wants, so there is no ffmpeg dependency, no lossy Opus
intermediate and no decode step. A WAV is also append-only and repairable.

**No database.** The filesystem is the source of truth. Search scans transcripts directly, so
there is no index that can fall out of sync with the files.

**Metadata is the queue.** There is no separate queue file. On startup the app scans for
recordings in a non-terminal state and re-enqueues them, so an unclean shutdown recovers for
free and the queue can never disagree with the recordings.

## Durability

`WavWriter` appends audio and rewrites the header's length fields roughly every two seconds,
so a hard crash costs at most that much audio and leaves a valid WAV on disk. `repairWav()`
recomputes the header from the true file size for anything written after the last flush.

Metadata is written with write-temp, `fsync`, `rename`, then `fsync` the directory. Rename is
atomic within a directory on both APFS and NTFS, so a crash leaves either the old file or the
new one, never a truncated one.

## The deletion guard

`src/main/cleanup/audio-cleanup.ts` is the only module in the codebase that unlinks audio. It
re-reads every precondition from disk rather than trusting the caller:

- verification status is `passed` **and** the issue list is empty
- transcription status is `complete`
- the transcript file independently exists on disk and is non-empty

Write ordering is: persist the verdict with `audioDeleted: false` and fsync, unlink the audio,
then persist `audioDeleted: true`. A crash before the unlink leaves audio present and metadata
honest; a crash between the unlink and the final write is corrected by `reconcile()` on next
launch. `reconcile()` only ever moves metadata toward the truth on disk and never deletes
anything.

The transcript is written to disk *before* verification runs, so a crash during verification
still leaves the user with their text.

`test/cleanup.test.mts` asserts each of these failure modes keeps the audio.

On startup, any recording left in `recording` or `saving` state has its WAV header
rebuilt by `repairWav()` before it is queued, recovering the audio written after the
last flush. Without that step a crash silently truncates the transcript at the last
flush boundary.

## Verification

Runs against the whisper JSON and the WAV itself. Any issue at all means the audio is kept.

| Check | Signal |
|---|---|
| `empty_transcript` | under ~10 chars or no segments |
| `duration_mismatch` | WAV length disagrees with what was recorded |
| `incomplete_coverage` | transcript covers under 90% of the audio |
| `suspicious_gap` | a >15s gap that has real RMS energy in the WAV |
| `low_confidence` | mean or per-segment token logprob below threshold |
| `repetition_loop` | the same phrase repeated 5+ times consecutively |
| `non_speech_annotation` | transcript is mostly `[MUSIC PLAYING]`-style markers |
| `audio_unreadable` / `process_error` | engine or file failure |

Gaps are checked against actual audio energy so that genuine silence does not false-positive.

**A note on confidence.** The current whisper.cpp CLI does not emit `avg_logprob` or
`no_speech_prob` in its JSON; only per-token probabilities. The parser derives a segment average
from those, excluding control tokens like `[_BEG_]` which always report p=1 and would inflate
it. Observed behaviour is that whisper reports *high* confidence even when hallucinating, which
is precisely why `non_speech_annotation` and `repetition_loop` exist — they catch failures that
confidence scoring does not.

## Content security policy

The renderer's CSP must include `blob:` in `script-src`. The PCM capture worklet is
loaded from a blob URL, and Chromium checks `AudioWorklet.addModule()` against
`script-src` rather than `worker-src`. Without it, `addModule()` rejects with an
opaque `AbortError: The user aborted a request.` and recording cannot start.

## Window lifecycle

`mainWindow` is set to `null` in the window's `closed` handler. A plain
`if (mainWindow)` check passes for a *destroyed* window, and touching one throws
`TypeError: Object has been destroyed`. Handlers that may run after the window is
gone (`second-instance`, `activate`) check `isDestroyed()` and reopen rather than
assuming a live window.

The single-instance lock is taken only in packaged builds. In development a stale
instance would otherwise absorb every relaunch and silently present the previous
build.

## Platform differences

Isolated to three places: `storage/paths.ts` (filename legality, reserved Windows names),
`transcription/whisper.ts` (binary path and `.exe` suffix, `windowsHide`), and
`electron-builder.yml`. macOS additionally pre-flights microphone consent via
`systemPreferences.askForMediaAccess` and declares `NSMicrophoneUsageDescription`.
