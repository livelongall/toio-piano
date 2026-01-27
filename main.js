import * as Tone from "https://esm.sh/tone@14.8.49";
import { getPlayableNoteFromToioId } from "./toio_id_note_map.js";

/** toio BLE UUIDs */
const TOIO_SERVICE_UUID = "10b20100-5b3b-4571-9508-cf3efcd7bbae";
const ID_CHARACTERISTIC_UUID = "10b20101-5b3b-4571-9508-cf3efcd7bbae";
const LIGHT_CHARACTERISTIC_UUID = "10b20103-5b3b-4571-9508-cf3efcd7bbae";
const SOUND_CHARACTERISTIC_UUID = "10b20104-5b3b-4571-9508-cf3efcd7bbae";

const logEl = document.querySelector("#log");
const log = (s) => {
  logEl.textContent = s + "\n" + logEl.textContent;
};

const pianoEl = document.querySelector("#piano");
const transposeEl = document.querySelector("#transpose");
const instrumentEl = document.querySelector("#instrument");
const cubeSoundEl = document.querySelector("#cubeSound");
const testNotesEl = document.querySelector("#testNotes");

// --- Piano UI -------------------------------------------------
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);
function isBlack(midi) {
  return !WHITE.has(((midi % 12) + 12) % 12);
}

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

    const leftPx = i * (38 + 2) + 26; // tweak
    black.style.left = `${leftPx}px`;
    pianoEl.appendChild(black);
  }

  pianoEl.style.width = `${whiteMidis.length * (38 + 2)}px`;
}

function clearPressed(tag) {
  pianoEl
    .querySelectorAll(`.pressed${tag}`)
    .forEach((el) => el.classList.remove(`pressed${tag}`));
}
function pressKey(midi, tag) {
  clearPressed(tag);
  const el = pianoEl.querySelector(`[data-midi="${midi}"]`);
  if (el) el.classList.add(`pressed${tag}`);
}

function clearPressedUser() {
  pianoEl.querySelectorAll(`.pressedU`).forEach((el) => el.classList.remove("pressedU"));
}
function pressKeyUser(midi) {
  clearPressedUser();
  const el = pianoEl.querySelector(`[data-midi="${midi}"]`);
  if (el) el.classList.add("pressedU");
}

// --- Audio (Tone.js) -----------------------------------------
// Chrome autoplay policy: create/resume AudioContext ONLY after a user gesture.
let audioCtx = null;

let instrument = null;
let isAudioReady = false;

// If GitHub Pages is blocked in your environment, use this CDN baseUrl instead of
// https://tonejs.github.io/audio/salamander/
const SALAMANDER_BASE_URL = "https://cdn.jsdelivr.net/gh/Tonejs/audio@master/salamander/";

function getInstrumentMode() {
  const v = instrumentEl?.value || "acoustic_grand_piano";
  if (v === "acoustic_grand_piano") return "sampler";
  if (v === "marimba" || v === "vibraphone" || v === "acoustic_guitar_nylon") return "pluck";
  if (v === "church_organ") return "organ";
  if (v === "flute") return "duo";
  if (v === "trumpet" || v === "synth_brass_1") return "fm";
  if (v === "violin") return "mono";
  if (v === "electric_piano_1") return "am";
  return "poly";
}

function disposeInstrument() {
  try {
    instrument?.dispose?.();
  } catch {}
  instrument = null;
}

function createInstrument() {
  const mode = getInstrumentMode();

  if (mode === "sampler") {
    return new Tone.Sampler({
      urls: {
        C2: "C2.mp3",
        E2: "E2.mp3",
        G2: "G2.mp3",
        C3: "C3.mp3",
        E3: "E3.mp3",
        G3: "G3.mp3",
        C4: "C4.mp3",
        E4: "E4.mp3",
        G4: "G4.mp3",
        C5: "C5.mp3",
        E5: "E5.mp3",
        G5: "G5.mp3",
        C6: "C6.mp3",
      },
      release: 0.8,
      baseUrl: SALAMANDER_BASE_URL,
    }).toDestination();
  }

  if (mode === "pluck") return new Tone.PluckSynth().toDestination();

  if (mode === "organ") {
    return new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "square" },
      envelope: { attack: 0.01, decay: 0.1, sustain: 0.9, release: 0.3 },
    }).toDestination();
  }

  if (mode === "duo") return new Tone.DuoSynth().toDestination();
  if (mode === "fm") return new Tone.FMSynth().toDestination();
  if (mode === "am") return new Tone.AMSynth().toDestination();
  if (mode === "mono") return new Tone.MonoSynth().toDestination();

  return new Tone.PolySynth(Tone.Synth).toDestination();
}

async function ensureAudio() {
  // MUST be called from a user gesture (click/pointerdown)
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive",
    });
    // Tell Tone.js to use our AudioContext
    Tone.setContext(audioCtx);
  }

  if (audioCtx.state !== "running") {
    await audioCtx.resume();
    log("AudioContext resumed");
  }

  // Keep Tone's internal state consistent
  await Tone.start();

  // Reduce scheduling delay for responsive UI (do this only after context is ready)
  Tone.getContext().lookAhead = 0.0;

  // (Re)create instrument if needed
  if (!instrument || !isAudioReady) {
    disposeInstrument();
    instrument = createInstrument();

    // Wait for samples/buffers (Sampler) to finish loading to avoid:
    // "buffer is either not set or not loaded"
    try {
      await Tone.loaded();
      log("Tone buffers loaded");
    } catch (e) {
      log("Tone.loaded() failed: " + e);
    }

    isAudioReady = true;
    log(`Audio ready (Tone.js) mode=${getInstrumentMode()}`);
  }
}

function midiToNoteName(midi) {
  // MIDI 60 => C4
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const n = Math.round(Number(midi));
  const name = names[((n % 12) + 12) % 12];
  const octave = Math.floor(n / 12) - 1;
  return `${name}${octave}`;
}

function attack(noteNameOrMidi) {
  if (!instrument) return;
  const note = typeof noteNameOrMidi === "number" ? midiToNoteName(noteNameOrMidi) : noteNameOrMidi;
  instrument.triggerAttack(note);
}
function release(noteNameOrMidi) {
  if (!instrument) return;
  const note = typeof noteNameOrMidi === "number" ? midiToNoteName(noteNameOrMidi) : noteNameOrMidi;
  instrument.triggerRelease(note);
}
function releaseAll() {
  try {
    instrument?.releaseAll?.();
  } catch {}
}

function stopAll() {
  releaseAll();
  cubeStopSound("A").catch(() => {});
  cubeStopSound("B").catch(() => {});
  cubeState.A.currentNote = null;
  cubeState.B.currentNote = null;
  clearPressed("A");
  clearPressed("B");
  clearPressedUser();
}

// --- BLE / toio ID notification parsing ----------------------
function parseIdNotification(dataView) {
  const kind = dataView.getUint8(0);
  if (kind === 0x02) {
    const standardId = dataView.getUint32(1, true);
    const angle = dataView.getUint16(5, true);
    return { type: "standard", standardId, angle };
  }
  if (kind === 0x04) return { type: "missed" };
  return { type: "other", kind };
}

// --- Two cubes ------------------------------------------------
const cubeState = {
  A: { device: null, idChar: null, lightChar: null, soundChar: null, currentNote: null, currentMidi: null },
  B: { device: null, idChar: null, lightChar: null, soundChar: null, currentNote: null, currentMidi: null },
};

// Lamp: keep on while connected (A=blue, B=orange)
function rgbForTag(tag) {
  return tag === "A" ? { r: 0, g: 180, b: 255 } : { r: 255, g: 120, b: 0 };
}
async function setCubeLamp(tag) {
  const ch = cubeState[tag].lightChar;
  if (!ch) return;
  const { r, g, b } = rgbForTag(tag);
  await ch.writeValueWithResponse(new Uint8Array([0x03, 0x00, 0x01, 0x01, r, g, b]));
}

// Sound: play MIDI note number while ID is detected
async function cubeStopSound(tag) {
  const ch = cubeState[tag].soundChar;
  if (!ch) return;
  await ch.writeValueWithResponse(new Uint8Array([0x01]));
}
async function cubePlayMidi(tag, midiNote) {
  const ch = cubeState[tag].soundChar;
  if (!ch) return;
  await ch.writeValueWithResponse(new Uint8Array([0x03, 0x00, 0x01, 0xFF, midiNote & 0x7F, 0xFF]));
}

async function connectCube(tag) {
  await ensureAudio();

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [TOIO_SERVICE_UUID] }],
  });

  device.addEventListener("gattserverdisconnected", () => {
    log(`Cube ${tag}: disconnected`);
    const prev = cubeState[tag].currentNote;
    if (prev) {
      release(prev);
      cubeState[tag].currentNote = null;
      cubeState[tag].currentMidi = null;
      clearPressed(tag);
    }
    cubeStopSound(tag).catch(() => {});
  });

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(TOIO_SERVICE_UUID);

  const idCh = await service.getCharacteristic(ID_CHARACTERISTIC_UUID);
  const lightCh = await service.getCharacteristic(LIGHT_CHARACTERISTIC_UUID);
  const soundCh = await service.getCharacteristic(SOUND_CHARACTERISTIC_UUID);

  cubeState[tag].device = device;
  cubeState[tag].idChar = idCh;
  cubeState[tag].lightChar = lightCh;
  cubeState[tag].soundChar = soundCh;

  await setCubeLamp(tag);

  await idCh.startNotifications();
  idCh.addEventListener("characteristicvaluechanged", (ev) => {
    const dv = ev.target.value;
    const msg = parseIdNotification(dv);

    if (msg.type === "standard") {
      const transpose = Number(transposeEl.value);
      const playable = getPlayableNoteFromToioId(msg.standardId, transpose);
      if (!playable) {
        log(`Cube ${tag}: StandardID=${msg.standardId} (unmapped)`);
        return;
      }

      const prev = cubeState[tag].currentNote;
      const next = playable.noteName;

      if (prev && prev !== next) release(prev);
      if (prev !== next) {
        attack(next);
        cubeState[tag].currentNote = next;
      }

      cubeState[tag].currentMidi = playable.midi;
      pressKey(playable.midi, tag);

      if (cubeSoundEl?.checked) {
        cubePlayMidi(tag, playable.midi).catch((e) => log(`Cube ${tag} sound error: ${e}`));
      }

      log(`Cube ${tag}: ID=${playable.toioId} => ${playable.noteName} angle=${msg.angle}`);
    }

    if (msg.type === "missed") {
      const cur = cubeState[tag].currentNote;
      if (cur) release(cur);
      cubeState[tag].currentNote = null;
      cubeState[tag].currentMidi = null;
      clearPressed(tag);
      cubeStopSound(tag).catch(() => {});
      log(`Cube ${tag}: missed`);
    }
  });

  log(`Cube ${tag}: connected`);
}

// --- User controls: Piano + Test buttons ---------------------
function getMidiFromTarget(t) {
  const el = t?.closest?.(".key");
  if (!el) return null;
  const v = Number(el.dataset.midi);
  return Number.isFinite(v) ? v : null;
}
function getMidiFromTestButton(t) {
  const btn = t?.closest?.("button[data-midi]");
  if (!btn) return null;
  const v = Number(btn.dataset.midi);
  return Number.isFinite(v) ? v : null;
}

let userPressedMidi = null;

async function userAttack(midi) {
  await ensureAudio();
  userPressedMidi = midi;
  pressKeyUser(midi);
  attack(midi);
}
function userRelease() {
  if (userPressedMidi === null) return;
  release(userPressedMidi);
  userPressedMidi = null;
  clearPressedUser();
}

// Piano keys
pianoEl.addEventListener("pointerdown", (e) => {
  const midi = getMidiFromTarget(e.target);
  if (midi === null) return;
  e.preventDefault();
  userAttack(midi).catch((err) => log("User play error: " + err));
  pianoEl.setPointerCapture?.(e.pointerId);
});
pianoEl.addEventListener("pointerup", (e) => {
  userRelease();
  try {
    pianoEl.releasePointerCapture?.(e.pointerId);
  } catch {}
});
pianoEl.addEventListener("pointercancel", () => userRelease());
pianoEl.addEventListener("pointerleave", () => userRelease());

// Test Notes buttons
testNotesEl?.addEventListener("pointerdown", (e) => {
  const midi = getMidiFromTestButton(e.target);
  if (midi === null) return;
  e.preventDefault();
  userAttack(midi).catch((err) => log("Test play error: " + err));
  const btn = e.target.closest("button");
  btn?.setPointerCapture?.(e.pointerId);
});
testNotesEl?.addEventListener("pointerup", (e) => {
  userRelease();
  const btn = e.target.closest("button");
  try {
    btn?.releasePointerCapture?.(e.pointerId);
  } catch {}
});
testNotesEl?.addEventListener("pointercancel", () => userRelease());
testNotesEl?.addEventListener("pointerleave", () => userRelease());

// --- UI events ------------------------------------------------
buildPiano();

document.querySelector("#btnA").addEventListener("click", () => connectCube("A").catch((e) => log("Error A: " + e)));
document.querySelector("#btnB").addEventListener("click", () => connectCube("B").catch((e) => log("Error B: " + e)));
document.querySelector("#btnStop").addEventListener("click", () => stopAll());

instrumentEl?.addEventListener("change", () => {
  disposeInstrument();
  isAudioReady = false;
  log(`Instrument changed: ${instrumentEl.value} (tap a key / button to re-init)`);
});

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