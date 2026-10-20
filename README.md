# Control R2-D2 (littleBits Droid Inventor Kit)

Control web para el R2-D2 del Droid Inventor Kit vía Web Bluetooth.
En iPhone se abre con el navegador **Bluefy**; en Android o Mac, con Chrome.

- `protocol.js`: comandos del control hub `w32 ControlHub` (CRC-16/CCITT-FALSE).
- `app.js`: joystick, sonidos, freno y cola de envío.
- `test.mjs`: verificación contra los comandos capturados (se corre desde el proyecto original).


## Protocolo del hub w32

Sacado de la app oficial de Android (`cc.littlebits.projectstar.android` 2.0.4, clases `cc.littlebits.android.lbble.*`).
Todo va por la característica `d9d9e9e1-…` (escritura + notificaciones).

Mensaje: `[(comando << 1) | bit 8 del largo] [largo & 0xFF] [payload] [CRC16 alto] [CRC16 bajo]`,
CRC-16/CCITT-FALSE sobre el payload. Mensajes de más de 20 bytes se mandan en escrituras de 20 bytes.

| Comando | Payload | Uso |
|---|---|---|
| 1 `ACK` | error u16 (0 = ok) | respuesta del hub |
| 10 `SET_BITSNAP` | salida, valor | R2: salida 0 = dirección (servo), 1 = avance (motor DC en VAR, 0x89 = quieto) |
| 15 `PLAY_SFX` | sonido | 0x00–0x1B de fábrica, 0x80 = sonido de usuario |
| 17 `ERASE_ALL_USER_SFX` | — | borra solo los sonidos de usuario (puede tardar varios segundos) |
| 18 `BEGIN_NEW_SFX` | largo u32, nombre ≤ 24 | responde con el mismo comando |
| 19 `SEND_USER_SFX` | offset u32, ≤ 256 bytes | cada pedazo responde ACK |
| 35 `SET_VOLUME` | volumen | la app usa 10 |

Sonido de usuario: PCM de 8 bits sin signo (centro 127), mono, 11025 Hz, hasta 4 s.
La app normaliza, aplica `2·x[n] − 5·x[n−1] + 2·x[n−2]`, centra y escala a 8 bits (ver `audio.js`).
