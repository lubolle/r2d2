// Protocolo del control hub "w32 ControlHub" (Droid Inventor Kit).
// Formato de cada comando: [comando] [largo] [payload...] [CRC16 alto] [CRC16 bajo]
// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) calculado solo sobre el payload.

export const SERVICE_UUID = 'd9d9e9e0-aa4e-4797-8151-cb41cedaf2ad';
export const CONTROL_UUID = 'd9d9e9e1-aa4e-4797-8151-cb41cedaf2ad';
export const DEVICE_NAME = 'w32 ControlHub';

const CMD_MOTOR = 0x14;
const CMD_SOUND = 0x1e;
// En el Space Rover la dirección va en el 1 y el avance en el 2; en el R2
// la dirección (servo) responde en el 0. La app permite cambiarlos.
export const PORT_STEER = 0x00;
export const PORT_DRIVE = 0x02;

// Valores de motor observados en las capturas.
const STEER_LEFT = 0xfc;
const STEER_STRAIGHT = 0x96;
const STEER_RIGHT = 0x00;
const DRIVE_FORWARD = 0xff;
const DRIVE_STOP = 0x89;
const DRIVE_BACK = 0x07;

export function crc16(bytes) {
  let c = 0xffff;
  for (const b of bytes) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

export function packet(cmd, payload) {
  const c = crc16(payload);
  return Uint8Array.from([cmd, payload.length, ...payload, c >> 8, c & 0xff]);
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// Valor crudo del motor de dirección: s en [-1 (izquierda), 1 (derecha)].
export function steerValue(s) {
  s = clamp(s, -1, 1);
  const v = s < 0 ? STEER_STRAIGHT + -s * (STEER_LEFT - STEER_STRAIGHT)
                  : STEER_STRAIGHT - s * (STEER_STRAIGHT - STEER_RIGHT);
  return Math.round(v);
}

// Valor crudo del motor de avance: t en [-1 (atrás), 1 (adelante)], 0 = stop.
export function driveValue(t) {
  t = clamp(t, -1, 1);
  if (t === 0) return DRIVE_STOP;
  const v = t > 0 ? DRIVE_STOP + 1 + t * (DRIVE_FORWARD - DRIVE_STOP - 1)
                  : DRIVE_STOP - 1 + t * (DRIVE_STOP - 1 - DRIVE_BACK);
  return Math.round(v);
}

export const motorPacket = (port, value) => packet(CMD_MOTOR, [port, value]);
export const steerPacket = (s, port = PORT_STEER) => motorPacket(port, steerValue(s));
export const drivePacket = (t, port = PORT_DRIVE) => motorPacket(port, driveValue(t));
export const soundPacket = (id) => packet(CMD_SOUND, [id]);

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

// Respuestas del hub (notificaciones en CONTROL_UUID).
export function describeReply(bytes) {
  const hex = toHex(bytes);
  if (hex === '020200001D0F') return 'ok';
  if (hex === '020201031E5D') return 'rechazado';
  return hex;
}

// IDs 0x00–0x1B. Los que no tienen nombre se pueden explorar desde la app.
export const SOUNDS = [
  { id: 0x00, name: 'pensando', emoji: '🤔' },
  { id: 0x01, name: 'encendido', emoji: '⚡' },
  { id: 0x02, name: 'dudoso', emoji: '🤨' },
  { id: 0x04, name: 'preocupado', emoji: '😟' },
  { id: 0x06, name: 'pfff', emoji: '😛' },
  { id: 0x08, name: '¡guau!', emoji: '😮' },
  { id: 0x0a, name: 'cuento', emoji: '📖' },
  { id: 0x0c, name: '¡sorpresa!', emoji: '😲' },
  { id: 0x0e, name: 'arranque', emoji: '🚀' },
  { id: 0x0f, name: '¡grito!', emoji: '😱' },
  { id: 0x10, name: 'triste', emoji: '😢' },
  { id: 0x11, name: 'contento', emoji: '😊' },
  { id: 0x12, name: 'emocionado', emoji: '🤩' },
  { id: 0x13, name: 'bajando', emoji: '📉' },
  { id: 0x14, name: 'silbido', emoji: '🎵' },
  { id: 0x15, name: 'bip', emoji: '🔔' },
  { id: 0x16, name: 'blip', emoji: '💬' },
  { id: 0x17, name: 'te quiero', emoji: '❤️' },
  { id: 0x18, name: 'charla', emoji: '🗣️' },
  { id: 0x19, name: 'parloteo', emoji: '🐦' },
  { id: 0x1a, name: 'reto', emoji: '😠' },
  { id: 0x1b, name: 'gruñón', emoji: '😤' },
];
export const UNKNOWN_SOUND_IDS = [0x03, 0x05, 0x07, 0x09, 0x0b, 0x0d];
