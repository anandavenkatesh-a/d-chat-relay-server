/**
 * puzzles.js
 * "Next-gen" human-verification puzzle used during registration.
 *
 * DESIGN EVOLUTION — for whoever revisits this next:
 *   v1: single reaction-timing tap. Fatal flaw: never required
 *       perceiving anything — a bot just waited and responded.
 *   v2: discrete high/low tone clips, separated by silence, streamed
 *       over a full minute. Fixed v1's flaw (the count only exists in
 *       real audio), but had a remaining weakness: the SILENCE
 *       between tones is itself a trivially exploitable signal — a
 *       naive bot doesn't need real pitch detection at all, it can
 *       just watch for amplitude-above-threshold "onset" events (loud
 *       spike after silence) to cleanly segment and count events,
 *       then apply a much simpler high/low classifier to each
 *       isolated clip.
 *   v3 (this version): CONTINUOUS audio — no silence anywhere in the
 *       60-second stream. A low-level background noise bed plays the
 *       entire time; tones are blended (additively mixed) into that
 *       noise at random points, not isolated. This removes the
 *       "silence to key off of" signal entirely — a bot now needs
 *       genuine ongoing spectral analysis throughout the whole
 *       stream, not just onset detection. Humans don't lose anything
 *       here: pure tones remain highly perceptually salient against
 *       broadband noise thanks to pitch-based auditory stream
 *       segregation (the same mechanism that lets you pick a single
 *       voice out of a noisy room) — easy to ignore the noise, easy
 *       to hear the tone rise out of it.
 *
 * Delivery: the 60-second session is generated as a sequence of
 * CHUNK_DURATION_MS chunks, sent back-to-back with zero gap between
 * their scheduled times — the client plays each one immediately on
 * arrival, producing continuous playback with no audible seams. A
 * random subset of chunks (10-16, same as before) has a tone blended
 * into their noise bed at a random offset within the chunk; the rest
 * are pure noise. The count of HIGH-pitched tone chunks is still the
 * answer, unchanged from v2 — only how the audio is constructed and
 * delivered has changed.
 */

const SESSION_DURATION_MS = 60_000;
const CHUNK_DURATION_MS   = 2_000;
const TOTAL_CHUNKS        = SESSION_DURATION_MS / CHUNK_DURATION_MS; // 30

const MIN_TONE_CHUNKS = 10;
const MAX_TONE_CHUNKS = 16;

const SAMPLE_RATE = 44100;
const TONE_DURATION_MS = 450;
const HIGH_FREQ = 1046; // C6
const LOW_FREQ  = 523;  // C5 — one full octave below, easily discriminable

// Tuned deliberately close together — NOT loud-tone-over-quiet-noise.
// Pure tones remain perceptually salient to human hearing even at a
// fairly modest excess over a noise floor (the same pitch-based
// "pop out" effect referenced above). Keeping the gap modest means a
// bot can't even reliably find WHICH chunks contain a tone using
// simple volume/RMS measurement alone — every step genuinely requires
// spectral analysis, not just the final high/low classification.
const NOISE_AMPLITUDE = 0.09;
const TONE_AMPLITUDE  = 0.20;

const ANSWER_WINDOW_MS = 5000;

const sessions = new Map();

/**
 * One sample of broadband noise. Plain white noise (not filtered to
 * pink/brown) — simplest possible generator, and broadband noise has
 * no strong tonal component near either target frequency, which is
 * exactly what makes the pure sine tones stand out perceptually
 * against it.
 */
function noiseSample() {
  return (Math.random() * 2 - 1) * NOISE_AMPLITUDE;
}

/**
 * Generates one continuous audio chunk as a WAV, base64-encoded.
 * Noise plays for the chunk's full duration. If `toneFreq` is given,
 * a tone of that frequency is additively blended in at a random
 * offset within the chunk (with its own short fade envelope so it
 * emerges from and recedes back into the noise smoothly, rather than
 * appearing/disappearing abruptly — which would just recreate the
 * "onset to key off of" problem this redesign exists to remove).
 */
function generateChunkWav(toneFreq) {
  const numSamples = Math.floor(SAMPLE_RATE * (CHUNK_DURATION_MS / 1000));
  const samples = new Int16Array(numSamples);

  const noise = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    noise[i] = noiseSample();
  }

  let tone = null;
  let toneStartSample = 0;
  const toneNumSamples = Math.floor(SAMPLE_RATE * (TONE_DURATION_MS / 1000));

  if (toneFreq) {
    const maxStart = numSamples - toneNumSamples;
    toneStartSample = Math.floor(Math.random() * Math.max(1, maxStart));

    tone = new Float32Array(toneNumSamples);
    const fadeSamples = Math.floor(SAMPLE_RATE * 0.03); // 30ms fade — smooth emergence from noise
    for (let i = 0; i < toneNumSamples; i++) {
      const t = i / SAMPLE_RATE;
      let amp = TONE_AMPLITUDE;
      if (i < fadeSamples) amp *= i / fadeSamples;
      else if (i > toneNumSamples - fadeSamples) amp *= (toneNumSamples - i) / fadeSamples;
      tone[i] = Math.sin(2 * Math.PI * toneFreq * t) * amp;
    }
  }

  for (let i = 0; i < numSamples; i++) {
    let mixed = noise[i];
    if (tone && i >= toneStartSample && i < toneStartSample + toneNumSamples) {
      mixed += tone[i - toneStartSample];
    }
    mixed = Math.max(-1, Math.min(1, mixed)); // clip guard
    samples[i] = Math.round(mixed * 32767);
  }

  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }

  return buffer.toString('base64');
}

/**
 * Picks which chunks (out of TOTAL_CHUNKS) contain a tone, and
 * whether each is high or low. Returns the full per-chunk plan plus
 * the correct answer (count of high-tone chunks).
 */
function buildSchedule() {
  const K = MIN_TONE_CHUNKS + Math.floor(Math.random() * (MAX_TONE_CHUNKS - MIN_TONE_CHUNKS + 1));

  const allIndices = Array.from({ length: TOTAL_CHUNKS }, (_, i) => i);
  for (let i = allIndices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allIndices[i], allIndices[j]] = [allIndices[j], allIndices[i]];
  }
  const toneChunkIndices = new Set(allIndices.slice(0, K));

  let correctAnswer = 0;
  const chunks = [];
  for (let i = 0; i < TOTAL_CHUNKS; i++) {
    let toneFreq = null;
    if (toneChunkIndices.has(i)) {
      const isHigh = Math.random() < 0.5;
      if (isHigh) correctAnswer++;
      toneFreq = isHigh ? HIGH_FREQ : LOW_FREQ;
    }
    chunks.push({
      index: i,
      scheduledAt: i * CHUNK_DURATION_MS,
      audioBase64: generateChunkWav(toneFreq),
    });
  }

  return { chunks, correctAnswer, total: TOTAL_CHUNKS };
}

function startSession(ws, { onSessionStart, onChunk, onAnswerWindowOpen }) {
  const { chunks, correctAnswer, total } = buildSchedule();

  const session = { correctAnswer, answerDeadline: null, timers: [] };
  sessions.set(ws, session);

  onSessionStart(total);

  chunks.forEach((chunk, i) => {
    const isFinal = i === chunks.length - 1;
    const timer = setTimeout(() => {
      onChunk({ index: chunk.index, total, audioBase64: chunk.audioBase64, isFinal });

      if (isFinal) {
        session.answerDeadline = Date.now() + ANSWER_WINDOW_MS;
        onAnswerWindowOpen(ANSWER_WINDOW_MS);
      }
    }, chunk.scheduledAt);

    session.timers.push(timer);
  });
}

function clearSession(ws) {
  const session = sessions.get(ws);
  if (session) session.timers.forEach(clearTimeout);
  sessions.delete(ws);
}

function submitResponse(ws, providedCount) {
  const session = sessions.get(ws);
  if (!session || session.answerDeadline === null) return { pass: false };

  const withinDeadline = Date.now() <= session.answerDeadline;
  const correctCount = Number(providedCount) === session.correctAnswer;

  clearSession(ws);
  return { pass: withinDeadline && correctCount };
}

module.exports = {
  startSession,
  clearSession,
  submitResponse,
  SESSION_DURATION_MS,
  CHUNK_DURATION_MS,
  ANSWER_WINDOW_MS,
};
