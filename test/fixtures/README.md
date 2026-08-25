# Test fixtures

Real whisper.cpp output, not hand-written mocks, so the verification tests run
against the shapes the engine actually produces.

| File | What it is |
|---|---|
| `good.wav` / `good.json` | ~12s of clear speech, transcribed accurately. Must verify with zero issues. |
| `recording.wav` / `recording.json` | ~1.8s of near-silence that whisper hallucinated as `[MUSIC PLAYING]` — with high token confidence. Must be flagged so the audio is kept. |

Regenerate with:

```bash
say -r 175 -o raw.aiff "…"
ffmpeg -i raw.aiff -ar 16000 -ac 1 -c:a pcm_s16le good.wav
whisper-cli -m ggml-tiny.en.bin -f good.wav --output-json-full --output-file good
```
