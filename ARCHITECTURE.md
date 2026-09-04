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

**File import decodes in the renderer.** Importing an mp4 or mp3 is the one place the app has
to deal with a compressed format, and the obvious answer -- bundle ffmpeg -- would add ~80 MB
per platform to a binary that is already fighting code signing. Electron ships the same
demuxers Chrome does, so `decodeAudioData` handles every format worth supporting with nothing
to install.

`decodeAudioData` resamples its result to the sample rate of the context it is called on, so
the decode runs through a 16 kHz `OfflineAudioContext` and never materialises the file at its
native rate: a one-hour 48 kHz stereo lecture is 1.4 GB of Float32 decoded natively and 230 MB
decoded at 16 kHz. That behaviour is a property of the call rather than something it can be
asked for, so `import.ts` checks the result and conforms it through a render pass if it ever
comes back otherwise.

The decoded PCM is streamed to main over IPC in ~30 s chunks and written by the same
`WavWriter` the microphone uses, so the queue, verification and cleanup all run unchanged. The
main process is never told where the source file lives -- only its base name, for the title --
which is what makes it structurally impossible for the cleanup step to reach the user's
original file.

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

`WavWriter` serialises every operation against its file handle. `append` derives its write
offset from a running byte count, so two appends in flight at once both read the same offset and
the second lands on top of the first. Overlap is the normal case rather than a rare one:
microphone PCM arrives as fire-and-forget IPC that never awaits the previous write, and an
import streams its chunks back to back. `test/wav.test.mts` asserts that twenty overlapping
appends produce twenty chunks of audio.

Recording directories are claimed by creating them, not by scanning and then creating. With two
capture paths a check-then-act allocation is reachable: a recording and an import starting
together both see the same highest id and are handed the same directory, so one overwrites the
other's audio. `mkdir` without `recursive` fails on an existing directory, which makes the
create itself the claim.

`WavWriter` appends audio and rewrites the header's length fields roughly every two seconds,
so a hard crash costs at most that much audio and leaves a valid WAV on disk. `repairWav()`
recomputes the header from the true file size for anything written after the last flush.

Metadata is written with write-temp, `fsync`, `rename`, then `fsync` the directory. Rename is
atomic within a directory on both APFS and NTFS, so a crash leaves either the old file or the
new one, never a truncated one.

## The deletion guard

`src/main/cleanup/audio-cleanup.ts` is the only module in the codebase that unlinks audio. There
are two ways in and they share one `unlinkAudio` helper, so they cannot drift apart: automatic
deletion after a clean verification, and deletion after the user explicitly accepts a flagged
transcript. Both re-read every precondition from disk rather than trusting the caller.

`deleteAudioIfVerified` requires:

- verification status is `passed` **and** the issue list is empty
- transcription status is `complete`
- the transcript file independently exists on disk and is non-empty

`deleteAudioOnAcceptance` waives exactly one of those -- that the report be clean -- and nothing
else. It requires `verification.status === 'accepted'`, read back from metadata rather than
asserted by the caller, so a stale in-memory object cannot authorise a deletion. It specifically
cannot waive the transcript precondition: once the audio is gone the transcript is all that is
left, so deleting audio to keep nothing would be the exact loss this module exists to prevent.
`queue.accept()` refuses upfront when the transcript is empty rather than leaving a recording
marked complete with its audio still held.

Acceptance is recorded, not erased. The issues stay in metadata as the factual record of what the
checker found, `verification.status` becomes `accepted` rather than `passed`, and `acceptedAt` is
stamped. That keeps an accepted transcript distinguishable from a clean pass, and means the
automatic path -- which requires `passed` -- still refuses it, so acceptance cannot become a
second, quieter route into zero-issue deletion. `whisper.json` is kept too, since the issues it
explains are still on record.

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

An interrupted **import** is the exception: it is failed rather than queued. Its header already
matches its truncated payload, so every verification check would pass and the user would get a
clean transcript covering only the part that had been decoded, with nothing to indicate the
rest was missing. The source file is untouched, so importing again costs nothing -- which makes
failing loudly strictly better than transcribing what landed.

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

## Import limits

`decodeAudioData` needs the whole container in one ArrayBuffer, so the ceiling on an importable
file is V8's maximum ArrayBuffer length: exactly `2**31 - 2**21`, or 2 GiB - 2 MiB.

That number is a V8 build constant rather than anything about the machine. Measured on an 8 GB
M2, it is byte-identical across repeated runs and unchanged with a gigabyte already committed
and touched, so there is nothing to compute per computer -- a workstation with 128 GB is capped
at the same 2,145,386,496 bytes. It moves only when the bundled Chromium does, which is why
`import.ts` writes it as that expression rather than a rounded-down guess.

The size is checked up front because the platform's own errors misattribute the cause: a 3.2 GB
blob read rejects in 12 ms with `NotReadableError` worded as a permissions problem, and a file
just under the cap throws `RangeError: Array buffer allocation failed`. Neither identifies the
real reason, so both are also caught and reported as the size, since allocation can fail below
the cap when memory is tight.

Decoding is single-file-at-a-time: two at once doubles peak memory for no throughput gain, and
the importer owns one session regardless.

Lifting the cap means not using `decodeAudioData`. WAV is raw PCM and could be sliced at frame
boundaries with no dependency; mp4 and m4a would need a JS demuxer feeding WebCodecs. Neither is
implemented -- compressed audio does not come close to the ceiling (a 128 kbps `.m4a` would need
35 hours), so only long video and uncompressed WAV reach it.

## Platform differences

Isolated to three places: `storage/paths.ts` (filename legality, reserved Windows names),
`transcription/whisper.ts` (binary path and `.exe` suffix, `windowsHide`), and
`electron-builder.yml`. macOS additionally pre-flights microphone consent via
`systemPreferences.askForMediaAccess` and declares `NSMicrophoneUsageDescription`.
