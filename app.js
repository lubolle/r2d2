import {
  SERVICE_UUID, CONTROL_UUID, DEVICE_NAME, SOUNDS, UNKNOWN_SOUND_IDS,
  CMD, USER_SFX, SFX_RATE, SFX_CHUNK, BLE_WRITE_SIZE,
  steerValue, driveValue, steerPacket, drivePacket, soundPacket, motorPacket, describeReply, toHex,
  parseMessage, ackError, eraseUserSfxPacket, beginSfxPacket, sfxChunkPacket,
} from './protocol.js?v=7';
import { decodedToHubBytes, previewHubBytes, startRecording } from './audio.js?v=7';

// Pausa entre comandos para no saturar el hub (el original usaba ~100–150 ms).
const GAP_MS = 80;
// Mientras se maneja, reenvía la velocidad aunque no cambie.
const KEEPALIVE_MS = 300;
const DEADZONE = 0.15;
const SLOW_SPEED = 0.6;
const RECONNECT_TRIES = 5;

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Estado ----------

let device = null;
let characteristic = null;
let userDisconnected = false;
let slowMode = false;
// Lo que el joystick pide y lo último que el hub confirmó (valores crudos).
const target = { steer: 0, drive: 0 };
const sent = { steer: null, drive: null };
let lastDriveAt = 0;
try {
  localStorage.removeItem('ports'); // de la v4, cuando los puertos se elegían a mano
} catch {
  // sin almacenamiento
}
// Comandos sueltos (sonidos y pruebas), se mandan antes que el joystick.
const queue = [];
let steerTurn = true;
// Mientras se sube un sonido, el loop de envío se pausa y las respuestas
// del hub van a quien las esté esperando.
let busy = false;
let inflight = null;
let waiter = null;

// ---------- Bluetooth ----------

async function connect() {
  if (!navigator.bluetooth) {
    showMessage('Este navegador no tiene Bluetooth. En iPhone abrí esta página con la app Bluefy.');
    return;
  }
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ name: DEVICE_NAME }, { namePrefix: 'w32' }],
      optionalServices: [SERVICE_UUID],
    });
  } catch {
    return; // el usuario cerró el selector
  }
  device.addEventListener('gattserverdisconnected', onDisconnected);
  userDisconnected = false;
  await openConnection();
}

async function openConnection() {
  setStatus('connecting');
  try {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    characteristic = await service.getCharacteristic(CONTROL_UUID);
  } catch (e) {
    characteristic = null;
    setStatus('disconnected');
    showMessage('No me pude conectar. ¿Está prendido el R2? Probá de nuevo.');
    throw e;
  }
  try {
    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', (e) => {
      const v = e.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
      const reply = describeReply(bytes);
      $('#reply').textContent = reply;
      if (waiter) waiter(parseMessage(bytes));
      else log(`← ${reply}`);
    });
  } catch {
    // Las respuestas son solo informativas.
  }
  sent.steer = sent.drive = null;
  stop();
  setStatus('connected');
  showMessage('');
  log('conectado');
  queue.push(soundPacket(0x0e));
}

async function onDisconnected() {
  characteristic = null;
  setStatus('disconnected');
  log('desconectado');
  if (userDisconnected) return;
  for (let i = 0; i < RECONNECT_TRIES && !userDisconnected; i++) {
    await sleep(1000);
    try {
      await openConnection();
      return;
    } catch {
      // reintenta
    }
  }
}

function disconnect() {
  userDisconnected = true;
  stop();
  setTimeout(() => device?.gatt?.disconnect(), GAP_MS * 3);
}

function write(pkt) {
  const fn = characteristic.writeValueWithResponse || characteristic.writeValue;
  return fn.call(characteristic, pkt);
}

// Elige el próximo comando: primero frenar, después sonidos y pruebas,
// después dirección y avance alternados. Solo manda valores que cambiaron,
// salvo el avance, que se repite cada KEEPALIVE_MS mientras se maneja.
function nextCommand() {
  const steer = steerValue(target.steer);
  const drive = driveValue(target.drive);
  if (drive === driveValue(0) && sent.drive !== drive) return ['drive', drive, drivePacket(0)];
  if (queue.length) return [null, null, queue.shift()];
  const order = steerTurn ? ['steer', 'drive'] : ['drive', 'steer'];
  steerTurn = !steerTurn;
  for (const key of order) {
    if (key === 'steer' && sent.steer !== steer) return ['steer', steer, steerPacket(target.steer)];
    if (key === 'drive' && sent.drive !== drive) return ['drive', drive, drivePacket(target.drive)];
  }
  if (target.drive !== 0 && Date.now() - lastDriveAt > KEEPALIVE_MS) return ['drive', drive, drivePacket(target.drive)];
  return null;
}

async function pump() {
  for (;;) {
    const cmd = characteristic && !busy && nextCommand();
    if (cmd) {
      const [key, value, pkt] = cmd;
      try {
        inflight = write(pkt);
        await inflight;
        if (key) sent[key] = value;
        if (key === 'drive') lastDriveAt = Date.now();
        log(`→ ${toHex(pkt)}`);
      } catch (e) {
        log(`✗ ${toHex(pkt)} ${e.message}`); // se reintenta en la próxima vuelta
      }
    }
    await sleep(GAP_MS);
  }
}

// ---------- Sonido propio ----------

// Manda un mensaje en escrituras de 20 bytes (como la app oficial).
async function writeChunked(pkt) {
  for (let i = 0; i < pkt.length; i += BLE_WRITE_SIZE) {
    const piece = pkt.slice(i, i + BLE_WRITE_SIZE);
    const last = i + BLE_WRITE_SIZE >= pkt.length;
    const fast = !last && characteristic.writeValueWithoutResponse;
    await (fast ? characteristic.writeValueWithoutResponse(piece) : write(piece));
  }
}

// Manda un mensaje y espera la respuesta del hub.
function request(pkt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiter = null; reject(new Error('el R2 no respondió')); }, timeoutMs);
    waiter = (msg) => { clearTimeout(timer); waiter = null; resolve(msg); };
    writeChunked(pkt).catch((e) => { clearTimeout(timer); waiter = null; reject(e); });
  });
}

const isOk = (msg) => msg?.cmd === CMD.ACK && ackError(msg) === 0;

// Misma secuencia que la app oficial: borrar sonidos de usuario, anunciar el
// nuevo y mandarlo en pedazos de 256 bytes (reintentando los que fallen).
async function uploadUserSfx(bytes, onProgress) {
  busy = true;
  try {
    await inflight?.catch(() => {});
    await request(drivePacket(0), 1500).catch(() => {});
    const erased = await request(eraseUserSfxPacket(), 20000);
    if (!isOk(erased)) log(`borrar: respuesta cmd ${erased?.cmd}, error ${ackError(erased)}`);
    const begin = await request(beginSfxPacket(bytes.length, 'sound0'), 3000);
    if (begin?.cmd !== CMD.BEGIN_NEW_SFX) throw new Error(`el R2 no aceptó el sonido (error ${ackError(begin)})`);
    for (let offset = 0; offset < bytes.length; offset += SFX_CHUNK) {
      const chunk = bytes.subarray(offset, offset + SFX_CHUNK);
      for (let attempt = 1; ; attempt++) {
        try {
          const reply = await request(sfxChunkPacket(offset, chunk), 3000);
          if (isOk(reply)) break;
          throw new Error(`error ${ackError(reply)}`);
        } catch (e) {
          if (attempt >= 4) throw e;
          log(`reintento en ${offset}: ${e.message}`);
        }
      }
      onProgress((offset + chunk.length) / bytes.length);
    }
  } finally {
    busy = false;
    sent.steer = sent.drive = null;
  }
}

let audioCtx = null;
const getAudioCtx = () => (audioCtx ??= new (window.AudioContext || window.webkitAudioContext)());
let pendingSfx = null;
let stopRecording = null;

function setPending(bytes, label) {
  if (!bytes.length) return showCustomStatus('No se escuchó nada. Probá de nuevo.');
  pendingSfx = bytes;
  $('#customReady').hidden = false;
  showCustomStatus(`${label}: ${(bytes.length / SFX_RATE).toFixed(1)} s listos para mandar.`);
}

function showCustomStatus(text) {
  $('#customStatus').textContent = text;
}

function decodeAudio(arrayBuffer) {
  return new Promise((resolve, reject) => getAudioCtx().decodeAudioData(arrayBuffer, resolve, reject));
}

function setupCustomSound() {
  $('#customPlay').addEventListener('click', () => playSound(USER_SFX));

  const rec = $('#customRecord');
  if (!navigator.mediaDevices?.getUserMedia) rec.hidden = true;
  rec.addEventListener('pointerdown', async (e) => {
    rec.setPointerCapture(e.pointerId);
    try {
      stopRecording = await startRecording(getAudioCtx());
      rec.classList.add('recording');
      showCustomStatus('Grabando… (soltá para terminar, máximo 4 s)');
    } catch {
      showCustomStatus('No pude usar el micrófono. Probá con "Elegir audio".');
    }
  });
  const finish = () => {
    if (!stopRecording) return;
    rec.classList.remove('recording');
    setPending(stopRecording(), 'Grabación');
    stopRecording = null;
  };
  rec.addEventListener('pointerup', finish);
  rec.addEventListener('pointercancel', finish);

  $('#customFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      setPending(decodedToHubBytes(await decodeAudio(await file.arrayBuffer())), file.name);
    } catch {
      showCustomStatus('No pude leer ese archivo. Probá con un MP3, M4A o WAV.');
    }
  });

  $('#customPreview').addEventListener('click', () => pendingSfx && previewHubBytes(getAudioCtx(), pendingSfx));

  $('#customUpload').addEventListener('click', async () => {
    if (!pendingSfx) return;
    if (!characteristic) return showCustomStatus('Primero conectá el R2.');
    const progress = $('#customProgress');
    progress.hidden = false;
    $('#customUpload').disabled = true;
    try {
      await uploadUserSfx(pendingSfx, (p) => {
        progress.value = p;
        showCustomStatus(`Mandando… ${Math.round(p * 100)}%`);
      });
      showCustomStatus('¡Listo! Tocá ⭐ para escucharlo en el R2.');
      log('sonido propio cargado');
      playSound(USER_SFX);
    } catch (e) {
      showCustomStatus(`No se pudo mandar: ${e.message}`);
      log(`✗ sonido propio: ${e.message}`);
    } finally {
      progress.hidden = true;
      $('#customUpload').disabled = false;
    }
  });
}

// ---------- Controles ----------

function stop() {
  target.steer = 0;
  target.drive = 0;
}

function playSound(id) {
  if (!characteristic) return;
  queue.length = 0; // si tocan muchos botones, suena el último
  queue.push(soundPacket(id));
}

// Mapeo de interface06.html: hacia adelante (o de costado) gira según el
// ángulo; hacia atrás va recto. La velocidad depende de cuánto se empuja.
function setFromJoystick(nx, ny) {
  const dist = Math.min(1, Math.hypot(nx, ny));
  if (dist < DEADZONE) return stop();
  const power = ((dist - DEADZONE) / (1 - DEADZONE)) * (slowMode ? SLOW_SPEED : 1);
  const angle = Math.atan2(nx, ny); // 0 = arriba, ±π/2 = costados, ±π = abajo
  if (Math.abs(angle) <= 0.75 * Math.PI) {
    target.steer = Math.max(-1, Math.min(1, angle / (Math.PI / 2)));
    target.drive = power;
  } else {
    target.steer = 0;
    target.drive = -power;
  }
}

function setupJoystick() {
  const base = $('#joystick');
  const knob = $('#knob');
  let pointerId = null;

  const move = (e) => {
    const r = base.getBoundingClientRect();
    const radius = r.width / 2;
    let dx = (e.clientX - (r.left + radius)) / radius;
    let dy = (e.clientY - (r.top + radius)) / radius;
    const d = Math.hypot(dx, dy);
    if (d > 1) { dx /= d; dy /= d; }
    knob.style.transform = `translate(${dx * radius * 0.6}px, ${dy * radius * 0.6}px)`;
    setFromJoystick(dx, -dy);
    $('#target').textContent = `giro ${target.steer.toFixed(2)} · avance ${target.drive.toFixed(2)}`;
  };
  const release = () => {
    pointerId = null;
    knob.style.transition = 'transform .2s';
    knob.style.transform = '';
    stop();
    $('#target').textContent = 'giro 0 · avance 0';
  };

  base.addEventListener('pointerdown', (e) => {
    pointerId = e.pointerId;
    base.setPointerCapture(pointerId);
    knob.style.transition = 'none';
    move(e);
  });
  base.addEventListener('pointermove', (e) => { if (e.pointerId === pointerId) move(e); });
  base.addEventListener('pointerup', release);
  base.addEventListener('pointercancel', release);
  base.addEventListener('lostpointercapture', release);
}

function makeSoundButtons() {
  const grid = $('#sounds');
  for (const s of SOUNDS) {
    const b = document.createElement('button');
    b.className = 'sound';
    b.innerHTML = `<span class="emoji">${s.emoji}</span><span>${s.name}</span>`;
    b.addEventListener('click', () => playSound(s.id));
    grid.append(b);
  }
  const extra = $('#mystery');
  for (const id of UNKNOWN_SOUND_IDS) {
    const b = document.createElement('button');
    b.className = 'sound small';
    b.textContent = `❓ ${id.toString(16).padStart(2, '0').toUpperCase()}`;
    b.addEventListener('click', () => playSound(id));
    extra.append(b);
  }
}

// ---------- Diagnóstico ----------

const logLines = [];
function log(line) {
  const t = new Date().toLocaleTimeString('es', { hour12: false });
  logLines.unshift(`${t} ${line}`);
  logLines.length = Math.min(logLines.length, 40);
  $('#log').textContent = logLines.join('\n');
}

// Mueve un puerto de motor a fondo durante 1 s y lo vuelve a 0x89.
function testPort(port, value) {
  if (!characteristic) return log('primero conectá');
  log(`prueba puerto ${port} = ${value.toString(16).toUpperCase()}`);
  queue.push(motorPacket(port, value));
  setTimeout(() => queue.push(motorPacket(port, 0x89)), 1000);
}

function setupDebug() {
  $('#debugToggle').addEventListener('click', () => { $('#debug').hidden = !$('#debug').hidden; });

  const tests = $('#tests');
  for (let port = 0; port < 8; port++) {
    for (const [label, value] of [['▶', 0xff], ['◀', 0x07]]) {
      const b = document.createElement('button');
      b.textContent = `${port} ${label}`;
      b.addEventListener('click', () => testPort(port, value));
      tests.append(b);
    }
  }
}

// ---------- Interfaz ----------

function setStatus(status) {
  document.body.dataset.status = status;
  $('#status').textContent = { connected: 'Conectado', connecting: 'Conectando…', disconnected: 'Desconectado' }[status];
  $('#connect').textContent = status === 'disconnected' ? 'Conectar' : 'Desconectar';
}

function showMessage(text) {
  $('#message').textContent = text;
  $('#message').hidden = !text;
}

async function keepScreenOn() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    // no disponible
  }
}

$('#connect').addEventListener('click', () => (characteristic || document.body.dataset.status === 'connecting' ? disconnect() : connect()));
$('#stop').addEventListener('click', stop);
$('#slow').addEventListener('change', (e) => { slowMode = e.target.checked; });

// Frenar si la app pasa a segundo plano.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop();
  else keepScreenOn();
});
window.addEventListener('pagehide', stop);

if (!navigator.bluetooth) {
  showMessage('Este navegador no tiene Bluetooth. En iPhone abrí esta página con la app Bluefy.');
}

setStatus('disconnected');
setupJoystick();
setupDebug();
setupCustomSound();
makeSoundButtons();
keepScreenOn();
pump();
