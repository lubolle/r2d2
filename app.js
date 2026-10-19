import {
  SERVICE_UUID, CONTROL_UUID, DEVICE_NAME, SOUNDS, UNKNOWN_SOUND_IDS,
  steerValue, driveValue, steerPacket, drivePacket, soundPacket, motorPacket, describeReply, toHex,
} from './protocol.js';

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
// Comandos sueltos (sonidos y pruebas), se mandan antes que el joystick.
const queue = [];
let steerTurn = true;

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
      const reply = describeReply(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      $('#reply').textContent = reply;
      log(`← ${reply}`);
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
    const cmd = characteristic && nextCommand();
    if (cmd) {
      const [key, value, pkt] = cmd;
      try {
        await write(pkt);
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
  for (const b of document.querySelectorAll('[data-port]')) {
    b.addEventListener('click', () => testPort(Number(b.dataset.port), parseInt(b.dataset.value, 16)));
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
makeSoundButtons();
keepScreenOn();
pump();
