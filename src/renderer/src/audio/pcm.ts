/**
 * Convert Float32 [-1,1] samples to little-endian Int16, clamping on the way.
 *
 * Shared by both capture paths so the microphone and an imported file produce
 * byte-identical PCM for the same waveform.
 */
export function floatToPcm16(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]))
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return out.buffer
}
