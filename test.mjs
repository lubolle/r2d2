// Verifica el protocolo contra los comandos capturados del proyecto original.
// (No incluye 'w32 sounds': son cuentas a mano del autor, no capturas.)
// Uso: node r2d2-web/test.mjs
import { readFileSync } from 'node:fs';
import { packet, toHex, steerValue, driveValue, steerPacket, drivePacket, soundPacket } from './protocol.js';

const root = new URL('../', import.meta.url);
const files = ['360 deg', 'drive motor', 'turn signals', 'drivetests', 'interface06.html'];

let total = 0;
let failed = 0;
const fail = (msg) => { failed++; console.error('FALLA:', msg); };

for (const f of files) {
  const text = readFileSync(new URL(encodeURIComponent(f), root), 'utf8').replace(/(?<=[0-9A-F]{2}) (?=[0-9A-F]{2})/g, '');
  for (const [hex] of text.matchAll(/\b(?:1402[0-9A-F]{8}|1E01[0-9A-F]{6}|46010A[0-9A-F]{4})\b/g)) {
    const bytes = hex.match(/../g).map((h) => parseInt(h, 16));
    const rebuilt = toHex(packet(bytes[0], bytes.slice(2, 2 + bytes[1])));
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

console.log(`${total - failed}/${total} OK`);
process.exit(failed ? 1 : 0);
