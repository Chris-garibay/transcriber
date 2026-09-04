# Transcriber

[![Release](https://github.com/Chris-garibay/transcriber/actions/workflows/release.yml/badge.svg)](https://github.com/Chris-garibay/transcriber/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[Download for macOS or Windows](https://chris-garibay.github.io/transcriber/)**

A local-first voice recorder and transcriber for use alongside Claude Code, Codex and other
terminal/IDE coding agents. Record a thought, get text, paste or reference it by path. You can
also import an audio or video file you already have and transcribe that.

Audio and transcription never leave your computer. After the required model is downloaded once,
the app works with no internet connection.

## Install

Grab a build from the [download page](https://chris-garibay.github.io/transcriber/) or
[releases](https://github.com/Chris-garibay/transcriber/releases/latest).

Builds are **not code-signed**, since signing requires paid Apple and Microsoft developer
accounts.

On macOS, clear the quarantine flag *before* the first launch — otherwise macOS may
decide the app is damaged and move it to the Trash:

```bash
xattr -dr com.apple.quarantine /Applications/Transcriber.app
```

On Windows, choose *More info* then *Run anyway* at the SmartScreen prompt.

## Building from source

```bash
npm install
npm run fetch:whisper   # downloads (Windows) or builds (macOS) the whisper.cpp CLI
npm run dev
```

On first launch the app offers a choice of transcription model. `small` is recommended.
Everything after that download is offline.

`npm run fetch:whisper` on macOS compiles whisper.cpp from source and needs `cmake` plus the
Xcode command line tools. On Windows it downloads the prebuilt x64 release.

## Importing an existing file

Press **Import file**, or drag files onto the main panel, to transcribe audio or video you
already have — a lecture recording, a meeting export, a voice memo. Several at once is fine;
they are decoded one at a time.

`.mp4`, `.mov`, `.webm`, `.mkv`, `.m4a`, `.mp3`, `.wav`, `.aac`, `.flac`, `.ogg`, `.opus` and
`.aiff` all work. There is no ffmpeg to install: decoding uses the same demuxers Chrome ships
with, which Electron already bundles.

The file is decoded to 16 kHz mono and saved as a normal recording, then transcribed and
verified exactly like something captured from the microphone. **Your original file is never
opened for writing, moved or deleted** — the app is only ever handed its contents and its name,
never its location, so the audio lifecycle below applies solely to the copy inside
`~/Transcriber`.

Two limits worth knowing:

- A file has to be decoded whole, and one buffer tops out at 2 GiB, so files above that are
  refused. This is a limit of the browser engine, identical on every computer — more memory does
  not raise it. Convert the audio to `.m4a` or `.mp3` first and import that instead; only long
  video and uncompressed WAV get anywhere near it (a 128 kbps `.m4a` would need 35 hours).
- Quitting mid-import discards the partial recording rather than transcribing it. A truncated
  import would otherwise produce a clean-looking transcript of only the first few minutes.

## Where your data lives

```
~/Transcriber/Projects/<Project>/<Recording>/
    transcript.txt     the transcript
    metadata.json      title, timestamps, duration, verification result
    recording.wav      present only while transcription is pending, or if review is needed
    whisper.json       raw engine output, kept only when there are issues to explain
```

Plain files, no database. Copy the tree anywhere, read it with any tool, hand a path to an agent:

```
Read: /Users/you/Transcriber/Projects/Zeric/Recording 014/transcript.txt
```

## The audio lifecycle

```
record ---+
          +-> save wav -> transcribe -> verify
import ---+
                                      |
              +-----------------------+-----------------------+
              | zero issues                    any issue      |
              | delete audio                   keep audio     |
              | mark complete                  mark needs review
```

Audio is deleted **only** when verification returns zero issues, and never on an error path.
For an imported file this means the 16 kHz copy inside `~/Transcriber`; the file you imported
from is never touched.
Verification checks for empty output, incomplete coverage of the audio, duration mismatch,
audible gaps that produced no text, low token confidence, repetition loops, and non-speech
annotations such as `[MUSIC PLAYING]` that indicate the model heard nothing usable.

If anything is uncertain, the recording is kept.

### Accepting a flagged transcript

Some issues never clear however often you retranscribe — a genuinely long pause, a noisy room, a
quiet speaker. **Accept transcript**, on the review warning, signs off on them: the warning
clears, the recording is marked complete and the audio it was holding is deleted.

The issues are kept on record rather than erased, and the verification status becomes `accepted`
rather than `passed`, so an accepted transcript is never mistaken for one that verified cleanly.
Accepting waives exactly one thing — that the report be clean. It cannot waive the requirement
that a non-empty transcript already exist on disk, so a recording with nothing transcribed
refuses to be accepted and keeps its audio.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run with hot reload |
| `npm test` | Verification, audio-cleanup and file-import safety tests |
| `npm run typecheck` | Type-check main, preload and renderer |
| `npm run package:mac` / `package:win` | Build a distributable |

`npm test` needs whisper fixtures; see `test/` for how they are generated.
