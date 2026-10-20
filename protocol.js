// Protocolo del control hub "w32 ControlHub" (Droid Inventor Kit), según la
// app oficial de Android (cc.littlebits.android.lbble.LbW32Message).
// Formato: [(comando << 1) | bit 8 del largo] [largo & 0xFF] [payload...] [CRC alto] [CRC bajo]
// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) calculado solo sobre el payload.
// Los mensajes de más de 20 bytes se mandan en escrituras BLE de 20 bytes.

export const SERVICE_UUID = 'd9d9e9e0-aa4e-4797-8151-cb41cedaf2ad';
export const CONTROL_UUID = 'd9d9e9e1-aa4e-4797-8151-cb41cedaf2ad';
export const DEVICE_NAME = 'w32 ControlHub';

export const CMD = {
  ACK: 1,                 // respuesta: payload = código de error de 16 bits (0 = ok)
  SET_BITSNAP: 10,        // [salida, valor]
  PLAY_SFX: 15,           // [sonido]; 0x00–0x1B de fábrica, 0x80 = sonido de usuario
  PAUSE_SFX: 16,
  ERASE_ALL_USER_SFX: 17, // borra solo los sonidos de usuario
  BEGIN_NEW_SFX: 18,      // [largo u32, nombre ≤ 24]; responde con el mismo comando
  SEND_USER_SFX: 19,      // [offset u32, ≤ 256 bytes de audio]
  SET_VOLUME: 35,         // [volumen]; la app usa 10
};
export const USER_SFX = 0x80;
// Audio de usuario: PCM de 8 bits sin signo (centro 127), mono, 11025 Hz, hasta 4 s.
export const SFX_RATE = 11025;
export const SFX_MAX_SECONDS = 4;
export const SFX_CHUNK = 256;
export const BLE_WRITE_SIZE = 20;
// En el Space Rover la dirección va en el 1 y el avance en el 2; en el R2-D2
// la dirección (servo) va en el 0 y el avance (motor DC en VAR) en el 1.
export const PORT_STEER = 0x00;
export const PORT_DRIVE = 0x01;

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

export function message(cmd, payload = []) {
  const c = crc16(payload);
  const n = payload.length;
  return Uint8Array.from([(cmd << 1) | ((n >> 8) & 1), n & 0xff, ...payload, c >> 8, c & 0xff]);
}

export function parseMessage(bytes) {
  if (bytes.length < 4) return null;
  const len = bytes[1] | ((bytes[0] & 1) << 8);
  return { cmd: bytes[0] >> 1, data: bytes.slice(2, 2 + len) };
}

const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

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

export const motorPacket = (port, value) => message(CMD.SET_BITSNAP, [port, value]);
export const steerPacket = (s, port = PORT_STEER) => motorPacket(port, steerValue(s));
export const drivePacket = (t, port = PORT_DRIVE) => motorPacket(port, driveValue(t));
export const soundPacket = (id) => message(CMD.PLAY_SFX, [id]);

export const eraseUserSfxPacket = () => message(CMD.ERASE_ALL_USER_SFX);
export function beginSfxPacket(length, name) {
  const ascii = Array.from(name.slice(0, 24), (ch) => ch.charCodeAt(0) & 0x7f);
  return message(CMD.BEGIN_NEW_SFX, [...u32(length), ...ascii]);
}
export const sfxChunkPacket = (offset, bytes) => message(CMD.SEND_USER_SFX, [...u32(offset), ...bytes]);

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

export const ackError = (msg) => (msg?.data.length >= 2 ? (msg.data[0] << 8) | msg.data[1] : 0);

// Respuestas del hub (notificaciones en CONTROL_UUID).
export function describeReply(bytes) {
  const msg = parseMessage(bytes);
  if (!msg) return toHex(bytes);
  if (msg.cmd === CMD.ACK) {
    const err = ackError(msg);
    return err ? `error ${err}` : 'ok';
  }
  return `cmd ${msg.cmd}: ${toHex(msg.data)}`;
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
