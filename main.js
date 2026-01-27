import Soundfont from "https://esm.sh/soundfont-player@0.15.7";
import { getPlayableNoteFromToioId } from "./toio_id_note_map.js";

/** toio BLE UUIDs */
const TOIO_SERVICE_UUID = "10b20100-5b3b-4571-9508-cf3efcd7bbae";
const ID_CHARACTERISTIC_UUID = "10b20101-5b3b-4571-9508-cf3efcd7bbae";
const LIGHT_CHARACTERISTIC_UUID = "10b20103-5b3b-4571-9508-cf3efcd7bbae"; // Light Control
const SOUND_CHARACTERISTIC_UUID = "10b20104-5b3b-4571-9508-cf3efcd7bbae"; // Sound Control

const logEl = document.querySelector("#log");
const log = (s) => { logEl.textContent = s + "\n" + logEl.textContent; };

const pianoEl = document.querySelector("#piano");
const transposeEl = document.querySelector("#transpose");
const instrumentEl = document.querySelector("#instrument");
const cubeSoundEl = document.querySelector("#cubeSound");

// ---- Audio (SoundFont) --------------------------------------
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let sfInstrument = null;
let isAudioReady = false;
let loadingInstrument = null;

function currentInstrumentName() {
  return instrumentEl?.value || "acoustic_grand_piano";
}

async function loadInstrument() {
  const name = currentInstrumentName();
  if (loadingInstrument) return loadingInstrument;

  loadingInstrument = Soundfont.instrument(audioCtx, name, {
    soundfont: "FluidR3_GM",
    format: "mp3",
  }).then((inst) => {
    sfInstrument = inst;
    loadingInstrument = null;
    log(`Instrument loaded: ${name}`);
    return inst;
  }).catch((e) => {
    loadingInstrument = null;
    throw e;
  });

  return loadingInstrument;
}

async function ensureAudio() {
  if (!isAudioReady) {
    await audioCtx.resume(); // must be in a user gesture
    isAudioReady = true;
    log("AudioContext resumed");
  }
  if (!sfInstrument) await loadInstrument();
}

async function changeInstrument() {
  stopAll();
  sfInstrument = null;
  await ensureAudio();
}

// --- Piano UI -------------------------------------------------
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);
function isBlack(midi) { return !WHITE.has(((midi % 12) + 12) % 12); }

const PIANO_MIN = 48; // C3
const PIANO_MAX = 84; // C6

function buildPiano() {
  pianoEl.innerHTML = "";
  const whiteMidis = [];
  for (let m = PIANO_MIN; m <= PIANO_MAX; m++) if (!isBlack(m)) whiteMidis.push(m);

  // render white keys
  whiteMidis.forEach((m) => {
    const key = document.createElement("div");
    key.className = "key white";
    key.dataset.midi = String(m);
    pianoEl.appendChild(key);
  });

  // render black keys
  const whiteIndexByMidi = new Map(whiteMidis.map((m, i) => [m, i]));
  for (let m = PIANO_MIN; m <= PIANO_MAX; m++) {
    if (!isBlack(m)) continue;
    const leftWhite = m - 1;
    if (!whiteIndexByMidi.has(leftWhite)) continue;
    const i = whiteIndexByMidi.get(leftWhite);

    const black = document.createElement("div");
    black.className = "key black";
    black.dataset.midi = String(m);
    black.style.left = `${i * (38 + 2) + 26}px`;
    pianoEl.appendChild(black);
  }

  pianoEl.style.width = `${whiteMidis.length * (38 + 2)}px`;
}

function clearPressed(tag) {
  pianoEl.querySelectorAll(`.pressed${tag}`).forEach(el => el.classList.remove(`pressed${tag}`));
}
function pressKey(midi, tag) {
  clearPressed(tag);
  const el = pianoEl.querySelector(`[data-midi="${midi}"]`);
  if (el) el.classList.add(`pressed${tag}`);
}
function clearPressedUser() {
  pianoEl.querySelectorAll(`.pressedU`).forEach(el => el.classList.remove(`pressedU`));
}
function pressKeyUser(midi) {
  clearPressedUser();
  const el = pianoEl.querySelector(`[data-midi="${midi}"]`);
  if (el) el.classList.add("pressedU");
}

// --- Two cubes ------------------------------------------------
const cubeState = {
  A: { device: null, idChar: null, lightChar: null, soundChar: null, currentNote: null, currentMidi: null },
  B: { device: null, idChar: null, lightChar: null, soundChar: null, currentNote: null, currentMidi: null },
};

function rgbForTag(tag) {
  return tag === "A" ? { r: 0, g: 180, b: 255 } : { r: 255, g: 120, b: 0 };
}
async function setCubeLamp(tag) {
  const ch = cubeState[tag].lightChar;
  if (!ch) return;
  const { r, g, b } = rgbForTag(tag);
  // Light Control: [0x03, duration, num, id, r, g, b] (duration=0 => forever)
  await ch.writeValueWithResponse(new Uint8Array([0x03, 0x00, 0x01, 0x01, r, g, b]));
}
async function cubeStopSound(tag) {
  const ch = cubeState[tag].soundChar;
  if (!ch) return;
  // Sound Stop: [0x01]
  await ch.writeValueWithResponse(new Uint8Array([0x01]));
}
async function cubePlayMidi(tag, midiNote) {
  const ch = cubeState[tag].soundChar;
  if (!ch) return;
  // MIDI note number play: [0x03, repeat, opCount, duration, midi, volume]
  // repeat=0 => infinite until next write
  await ch.writeValueWithResponse(new Uint8Array([0x03, 0x00, 0x01, 0xFF, midiNote & 0x7F, 0xFF]));
}

// --- BLE parse ------------------------------------------------
function parseIdNotification(dv) {
  const kind = dv.getUint8(0);
  if (kind === 0x02) return { type: "standard", standardId: dv.getUint32(1, true), angle: dv.getUint16(5, true) };
  if (kind === 0x04) return { type: "missed" };
  return { type: "other", kind };
}

// --- User piano play -----------------------------------------
const userNoteHandles = new Map(); // midi -> handle
function stopUserMidi(midi) {
  const h = userNoteHandles.get(midi);
  if (h?.stop) { try { h.stop(); } catch {} }
  userNoteHandles.delete(midi);
}
async function playUserMidi(midi) {
  await ensureAudio();
  const inst = sfInstrument;
  if (!inst) return;
  stopUserMidi(midi);
  const h = inst.play(midi, audioCtx.currentTime, { gain: 0.8, duration: 999 });
  userNoteHandles.set(midi, h);
}

// --- Stop all -------------------------------------------------
function stopAll() {
  for (const tag of ["A", "B"]) {
    const h = cubeState[tag].currentNote;
    if (h?.stop) { try { h.stop(); } catch {} }
    cubeState[tag].currentNote = null;
    cubeState[tag].currentMidi = null;
    clearPressed(tag);
    cubeStopSound(tag).catch(() => {});
  }
  for (const [midi] of userNoteHandles) stopUserMidi(midi);
  clearPressedUser();
}

// --- Connect cube --------------------------------------------
async function connectCube(tag) {
  await ensureAudio();

  const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [TOIO_SERVICE_UUID] }] });

  device.addEventListener("gattserverdisconnected", () => {
    log(`Cube ${tag}: disconnected`);
    const h = cubeState[tag].currentNote;
    if (h?.stop) { try { h.stop(); } catch {} }
    cubeState[tag].currentNote = null;
    cubeState[tag].currentMidi = null;
    clearPressed(tag);
    cubeStopSound(tag).catch(() => {});
  });

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(TOIO_SERVICE_UUID);

  cubeState[tag].idChar = await service.getCharacteristic(ID_CHARACTERISTIC_UUID);
  cubeState[tag].lightChar = await service.getCharacteristic(LIGHT_CHARACTERISTIC_UUID);
  cubeState[tag].soundChar = await service.getCharacteristic(SOUND_CHARACTERISTIC_UUID);

  await setCubeLamp(tag);

  await cubeState[tag].idChar.startNotifications();
  cubeState[tag].idChar.addEventListener("characteristicvaluechanged", (ev) => {
    const msg = parseIdNotification(ev.target.value);

    if (msg.type === "standard") {
      const transpose = Number(transposeEl.value);
      const playable = getPlayableNoteFromToioId(msg.standardId, transpose);
      if (!playable) { log(`Cube ${tag}: StandardID=${msg.standardId} (unmapped)`); return; }

      const nextMidi = playable.midi;
      if (cubeState[tag].currentMidi === nextMidi) {
        pressKey(nextMidi, tag);
        return;
      }

      const prev = cubeState[tag].currentNote;
      if (prev?.stop) { try { prev.stop(); } catch {} }

      const inst = sfInstrument;
      if (!inst) return;
      cubeState[tag].currentNote = inst.play(nextMidi, audioCtx.currentTime, { gain: 0.8, duration: 999 });
      cubeState[tag].currentMidi = nextMidi;

      pressKey(nextMidi, tag);

      if (cubeSoundEl?.checked) cubePlayMidi(tag, nextMidi).catch(e => log(`Cube ${tag} sound error: ${e}`));

      log(`Cube ${tag}: ID=${playable.toioId} => ${playable.noteName} angle=${msg.angle}`);
    }

    if (msg.type === "missed") {
      const cur = cubeState[tag].currentNote;
      if (cur?.stop) { try { cur.stop(); } catch {} }
      cubeState[tag].currentNote = null;
      cubeState[tag].currentMidi = null;
      clearPressed(tag);
      cubeStopSound(tag).catch(() => {});
      log(`Cube ${tag}: missed`);
    }
  });

  log(`Cube ${tag}: connected`);
}

// --- Boot + Events -------------------------------------------
buildPiano();

// piano click/touch (event delegation)
let userPressedMidi = null;
function getMidiFromTarget(t) {
  const el = t?.closest?.(".key");
  if (!el) return null;
  const v = Number(el.dataset.midi);
  return Number.isFinite(v) ? v : null;
}
pianoEl.addEventListener("pointerdown", (e) => {
  const midi = getMidiFromTarget(e.target);
  if (midi === null) return;
  e.preventDefault();
  userPressedMidi = midi;
  pressKeyUser(midi);
  playUserMidi(midi).catch(err => log("User play error: " + err));
});
window.addEventListener("pointerup", () => {
  if (userPressedMidi === null) return;
  stopUserMidi(userPressedMidi);
  userPressedMidi = null;
  clearPressedUser();
});
window.addEventListener("pointercancel", () => {
  if (userPressedMidi === null) return;
  stopUserMidi(userPressedMidi);
  userPressedMidi = null;
  clearPressedUser();
});

// UI
document.querySelector("#btnA").addEventListener("click", () => connectCube("A").catch(e => log("Error A: " + e)));
document.querySelector("#btnB").addEventListener("click", () => connectCube("B").catch(e => log("Error B: " + e)));
document.querySelector("#btnStop").addEventListener("click", () => stopAll());
instrumentEl?.addEventListener("change", () => { changeInstrument().catch(e => log("Instrument Error: " + e)); });
cubeSoundEl?.addEventListener("change", () => {
  if (!cubeSoundEl.checked) {
    cubeStopSound("A").catch(() => {});
    cubeStopSound("B").catch(() => {});
  } else {
    for (const tag of ["A", "B"]) {
      const m = cubeState[tag].currentMidi;
      if (m !== null && m !== undefined) cubePlayMidi(tag, m).catch(() => {});
    }
  }
});
