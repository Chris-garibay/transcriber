# Transcriber

[![Release](https://github.com/Chris-garibay/transcriber/actions/workflows/release.yml/badge.svg)](https://github.com/Chris-garibay/transcriber/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[Download for macOS or Windows](https://chris-garibay.github.io/transcriber/)**

A local-first voice recorder and transcriber for use alongside Claude Code, Codex and other
terminal/IDE coding agents. Record a thought, get text, paste or reference it by path.

Audio and transcription never leave your computer. After the required model is downloaded once,
the app works with no internet connection.

## Install

Grab a build from the [download page](https://chris-garibay.github.io/transcriber/) or
[releases](https://github.com/Chris-garibay/transcriber/releases/latest).

Builds are **not code-signed**, since signing requires paid Apple and Microsoft developer
accounts. On macOS run `xattr -dr com.apple.quarantine /Applications/Transcriber.app`
after installing; on Windows choose *More info* then *Run anyway* at the SmartScreen prompt.

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
record -> save wav -> transcribe -> verify
                                      |
              +-----------------------+-----------------------+
              | zero issues                    any issue      |
              | delete audio                   keep audio     |
              | mark complete                  mark needs review
```

Audio is deleted **only** when verification returns zero issues, and never on an error path.
Verification checks for empty output, incomplete coverage of the audio, duration mismatch,
audible gaps that produced no text, low token confidence, repetition loops, and non-speech
annotations such as `[MUSIC PLAYING]` that indicate the model heard nothing usable.

If anything is uncertain, the recording is kept.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run with hot reload |
| `npm test` | Verification and audio-cleanup safety tests |
| `npm run typecheck` | Type-check main, preload and renderer |
| `npm run package:mac` / `package:win` | Build a distributable |

`npm test` needs whisper fixtures; see `test/` for how they are generated.
