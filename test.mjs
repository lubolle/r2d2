// Verifica el protocolo contra los comandos capturados del proyecto original.
// (No incluye 'w32 sounds': son cuentas a mano del autor, no capturas.)
// Uso: node r2d2-web/test.mjs
import { readFileSync } from 'node:fs';
import {
  message, parseMessage, describeReply, toHex, steerValue, driveValue, steerPacket, drivePacket, soundPacket,
  CMD, USER_SFX, SFX_RATE, eraseUserSfxPacket, beginSfxPacket, sfxChunkPacket,
} from './protocol.js?v=9';
import { resample, trimSilence, toHubBytes } from './audio.js?v=9';

const root = new URL('../', import.meta.url);
const files = ['360 deg', 'drive motor', 'turn signals', 'drivetests', 'interface06.html'];

let total = 0;
let failed = 0;
const fail = (msg) => { failed++; console.error('FALLA:', msg); };

for (const f of files) {
  const text = readFileSync(new URL(encodeURIComponent(f), root), 'utf8').replace(/(?<=[0-9A-F]{2}) (?=[0-9A-F]{2})/g, '');
  for (const [hex] of text.matchAll(/\b(?:1402[0-9A-F]{8}|1E01[0-9A-F]{6}|46010A[0-9A-F]{4})\b/g)) {
    const bytes = hex.match(/../g).map((h) => parseInt(h, 16));
    const rebuilt = toHex(message(bytes[0] >> 1, bytes.slice(2, 2 + bytes[1])));
    total++;
    if (rebuilt !== hex) fail(`${f}: ${hex} != ${rebuilt}`);
  }
}

const eq = (actual, expected, label) => { total++; if (actual !== expected) fail(`${label}: ${actual} != ${expected}`); };
eq(toHex(soundPacket(0x0e)), '1E010E003E', 'sonido arranque');
eq(toHex(drivePacket(0, 2)), '140202897BCC', 'stop');
eq(toHex(drivePacket(1, 2)), '140202FF659D', 'adelante a fondo');
eq(toHex(drivePacket(-1, 2)), '140202070B8A', 'atrás a fondo');
eq(toHex(steerPacket(-1, 1)), '140201FC00AD', 'todo a la izquierda');
eq(toHex(steerPacket(0, 1)), '14020196CD41', 'recto');
eq(toHex(steerPacket(1, 1)), '140201002E3E', 'todo a la derecha');
eq(driveValue(0.01) > 0x89, true, 'adelante mínimo no es stop');
eq(driveValue(-0.01) < 0x89, true, 'atrás mínimo no es stop');
eq(steerValue(5), 0x00, 'dirección se limita');

// Comandos y respuestas según la app oficial.
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
eq(toHex(message(CMD.SET_VOLUME, [10])), '46010A40BA', 'volumen 10 (el "comando desconocido")');
eq(describeReply(fromHex('020200001D0F')), 'ok', 'respuesta ok');
eq(describeReply(fromHex('020201031E5D')), 'error 259', 'respuesta con error');
eq(toHex(soundPacket(USER_SFX)).slice(0, 6), '1E0180', 'reproducir sonido de usuario');
eq(toHex(eraseUserSfxPacket()), '2200FFFF', 'borrar sonidos de usuario (sin payload)');
eq(toHex(beginSfxPacket(44100, 'sound0')).slice(0, 24), '240A0000AC44736F756E6430', 'anunciar sonido nuevo');
const chunk = sfxChunkPacket(512, new Uint8Array(256).fill(127));
eq(chunk.length, 2 + 260 + 2, 'pedazo de audio: largo total');
eq(toHex(chunk.slice(0, 6)), '270400000200', 'pedazo de audio: bit alto del largo y offset');
const parsed = parseMessage(chunk);
eq(parsed.cmd === CMD.SEND_USER_SFX && parsed.data.length === 260, true, 'pedazo de audio: se vuelve a leer igual');

// Conversión de audio.
const tone = Float32Array.from({ length: 44100 * 6 }, (_, i) => (i < 4410 ? 0 : 0.5 * Math.sin(i / 10)));
const mono = resample([tone], 44100);
eq(mono.length, SFX_RATE * 6, 'resample a 11025 Hz');
eq(trimSilence(mono).length < mono.length, true, 'saca el silencio inicial');
const hub = toHubBytes(trimSilence(mono));
eq(hub.length <= SFX_RATE * 4, true, 'máximo 4 segundos');
eq(Math.min(...hub) >= 0 && Math.max(...hub) <= 255 && Math.max(...hub) > 200 && Math.min(...hub) < 55, true, 'usa todo el rango de 8 bits');

console.log(`${total - failed}/${total} OK`);
process.exit(failed ? 1 : 0);
