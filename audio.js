// Conversión de audio al formato de los sonidos de usuario del hub:
// PCM de 8 bits sin signo (centro 127), mono, 11025 Hz, hasta 4 s.
import { SFX_RATE, SFX_MAX_SECONDS, clamp } from './protocol.js?v=10';

// Mezcla a mono y baja la frecuencia promediando cada ventana (filtro anti-alias simple).
export function resample(channels, srcRate, dstRate = SFX_RATE) {
  const n = channels[0].length;
  const ratio = srcRate / dstRate;
  const out = new Float32Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.min(n, Math.max(from + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (const ch of channels) for (let j = from; j < to; j++) sum += ch[j];
    out[i] = sum / ((to - from) * channels.length);
  }
  return out;
}

// Saca el silencio del principio y del final, dejando un margen para no
// comerse el comienzo o el final suave de una palabra.
export function trimSilence(samples, threshold = 0.015, margin = Math.round(SFX_RATE * 0.15)) {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const limit = peak * threshold;
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]) <= limit) start++;
  while (end > start && Math.abs(samples[end - 1]) <= limit) end--;
  return samples.subarray(Math.max(0, start - margin), Math.min(samples.length, end + margin));
}

// Mismo procesamiento que la app oficial (RecordControl.processAudio):
// normaliza, realza agudos (2·x[n] − 5·x[n−1] + 2·x[n−2]), centra y pasa a 8 bits.
export function toHubBytes(samples) {
  samples = samples.subarray(0, SFX_RATE * SFX_MAX_SECONDS);
  if (samples.length < 3) return new Uint8Array(0);
  const filtered = new Float32Array(samples.length - 2);
  let mean = 0;
  for (let i = 2; i < samples.length; i++) {
    const v = 2 * samples[i] - 5 * samples[i - 1] + 2 * samples[i - 2];
    filtered[i - 2] = v;
    mean += v;
  }
  mean /= filtered.length;
  let peak = 0;
  for (let i = 0; i < filtered.length; i++) {
    filtered[i] -= mean;
    peak = Math.max(peak, Math.abs(filtered[i]));
  }
  peak = peak || 1;
  return Uint8Array.from(filtered, (v) => clamp(Math.round((v / peak) * 127 + 127), 0, 255));
}

export function decodedToHubBytes(audioBuffer) {
  const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, i) => audioBuffer.getChannelData(i));
  return toHubBytes(trimSilence(resample(channels, audioBuffer.sampleRate)));
}

// Reproduce en el teléfono cómo va a sonar en el R2.
export function previewHubBytes(ctx, bytes) {
  const buf = ctx.createBuffer(1, bytes.length, SFX_RATE);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bytes.length; i++) data[i] = (bytes[i] - 127) / 128;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

// Graba del micrófono mientras no se llame a stop() (máximo 4 s).
export async function startRecording(ctx) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let total = 0;
  const maxSamples = ctx.sampleRate * SFX_MAX_SECONDS;
  processor.onaudioprocess = (e) => {
    if (total >= maxSamples) return;
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    total += e.inputBuffer.length;
  };
  source.connect(processor);
  processor.connect(ctx.destination);
  return function stop() {
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    const samples = new Float32Array(Math.min(total, maxSamples));
    let offset = 0;
    for (const c of chunks) {
      const part = c.subarray(0, samples.length - offset);
      samples.set(part, offset);
      offset += part.length;
    }
    return toHubBytes(trimSilence(resample([samples], ctx.sampleRate)));
  };
}
