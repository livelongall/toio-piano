import { getPlayableNoteFromToioId } from "./toio_id_note_map.js";

/** toio BLE UUIDs */
const TOIO_SERVICE_UUID = "10b20100-5b3b-4571-9508-cf3efcd7bbae";
const ID_CHARACTERISTIC_UUID = "10b20101-5b3b-4571-9508-cf3efcd7bbae";
const LIGHT_CHARACTERISTIC_UUID = "10b20103-5b3b-4571-9508-cf3efcd7bbae";
const SOUND_CHARACTERISTIC_UUID = "10b20104-5b3b-4571-9508-cf3efcd7bbae";

const logEl = document.querySelector("#log");
const log = (s) => { logEl.textContent = s + "\n" + logEl.textContent; };

const pianoEl = document.querySelector("#piano");
const transposeEl = document.querySelector("#transpose");
const instrumentEl = document.querySelector("#instrument");
const cubeSoundEl = document.querySelector("#cubeSound");
const testNotesEl = document.querySelector("#testNotes");

// --- Piano UI -------------------------------------------------
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);
function isBlack(midi){ return !WHITE.has(((midi % 12) + 12) % 12); }

const PIANO_MIN = 48; // C3
const PIANO_MAX = 84; // C6

function buildPiano() {
  pianoEl.innerHTML = "";
  const whiteMidis = [];
  for (let m = PIANO_MIN; m <= PIANO_MAX; m++) if (!isBlack(m)) whiteMidis.push(m);

  // white keys
  whiteMidis.forEach((m) => {
    const key = document.createElement("div");
    key.className = "key white";
    key.dataset.midi = String(m);
    pianoEl.appendChild(key);
  });

  // black keys
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

function clearPressed(tag){
  pianoEl.querySelectorAll(`.pressed${tag}`).forEach(el => el.classList.remove(`pressed${tag}`));
}
function pressKey(midi, tag){
  clearPressed(tag);
  const el = pianoEl.querySelector(`[data-midi="${midi}"]`);
  if (el) el.classList.add(`pressed${tag}`);
}
function clearPressedUser(){
  pianoEl.querySelectorAll(`.pressedU`).forEach(el => el.classList.remove("pressedU"));
}
function pressKeyUser(midi){
  clearPressedUser();
  const el = pianoEl.querySelector(`[data-midi="${midi}"]`);
  if (el) el.classList.add("pressedU");
}

// --- Audio (Pure WebAudio: no external mp3, no Tone.js) -------
// Chrome autoplay policy: create/resume AudioContext ONLY after a user gesture.
let audioCtx = null;
let masterGain = null;
let filterNode = null; // optional "rich" filter

function getWaveType() {
  // Map your existing select values to oscillator types
  const v = instrumentEl?.value || "acoustic_grand_piano";
  if (v === "church_organ") return "square";
  if (v === "flute") return "sine";
  if (v === "trumpet" || v === "synth_brass_1") return "sawtooth";
  if (v === "violin") return "sawtooth";
  if (v === "electric_piano_1") return "triangle";
  if (v === "marimba" || v === "vibraphone") return "triangle";
  if (v === "acoustic_guitar_nylon") return "triangle";
  // default
  return "sine";
}

async function ensureAudio() {
  // MUST be called from user gesture (click/pointerdown)
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });

    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.9;

    // A simple lowpass for a slightly richer/less harsh sound (optional)
    filterNode = audioCtx.createBiquadFilter();
    filterNode.type = "lowpass";
    filterNode.frequency.value = 8000;
    filterNode.Q.value = 0.7;

    filterNode.connect(masterGain);
    masterGain.connect(audioCtx.destination);
  }

  if (audioCtx.state !== "running") {
    await audioCtx.resume();
    log("AudioContext resumed");
  }
}

function midiToFreq(midi) {
  const n = Number(midi);
  return 440 * Math.pow(2, (n - 69) / 12);
}

// Simple "voice" (press-and-hold)
function createVoice(freqHz) {
  const now = audioCtx.currentTime;

  // 2 oscillators (detune) -> richer than 1 osc
  const osc1 = audioCtx.createOscillator();
  const osc2 = audioCtx.createOscillator();
  osc1.type = getWaveType();
  osc2.type = getWaveType();

  osc1.frequency.setValueAtTime(freqHz, now);
  osc2.frequency.setValueAtTime(freqHz, now);
  osc2.detune.setValueAtTime(+7, now); // slight detune

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.0, now);

  // Attack/Release envelope
  const attack = 0.01;
  const sustain = 0.55;
  gain.gain.linearRampToValueAtTime(sustain, now + attack);

  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(filterNode);

  osc1.start(now);
  osc2.start(now);

  return {
    stop: () => {
      const t = audioCtx.currentTime;
      const release = 0.08;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0.0, t + release);
      osc1.stop(t + release + 0.02);
      osc2.stop(t + release + 0.02);
    },
  };
}

// Track playing notes
const userVoices = new Map(); // midi -> voice

function userStart(midi) {
  if (!audioCtx) return;
  if (userVoices.has(midi)) return;
  const v = createVoice(midiToFreq(midi));
  userVoices.set(midi, v);
}
function userStop(midi) {
  const v = userVoices.get(midi);
  if (!v) return;
  v.stop();
  userVoices.delete(midi);
}
function userStopAll() {
  for (const [m, v] of userVoices.entries()) {
    v.stop();
    userVoices.delete(m);
  }
}

// --- BLE / toio ID notification parsing ----------------------
function parseIdNotification(dataView) {
  const kind = dataView.getUint8(0);
  if (kind === 0x02) { // Standard ID
    const standardId = dataView.getUint32(1, true);
    const angle = dataView.getUint16(5, true);
    return { type: "standard", standardId, angle };
  }
  if (kind === 0x04) { // Standard ID missed
    return { type: "missed" };
  }
  return { type: "other", kind };
}

// --- Two cubes ------------------------------------------------
const cubeState = {
  A: { device:null, idChar:null, lightChar:null, soundChar:null, currentMidi:null },
  B: { device:null, idChar:null, lightChar:null, soundChar:null, currentMidi:null },
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

// Cube speaker
async function cubeStopSound(tag) {
  const ch = cubeState[tag].soundChar;
  if (!ch) return;
  await ch.writeValueWithResponse(new Uint8Array([0x01]));
}
async function cubePlayMidi(tag, midiNote) {
  const ch = cubeState[tag].soundChar;
  if (!ch) return;
  // [0x03, repeat(0=infinite), opCount(1), duration(0xFF=2550ms), midi, volume]
  await ch.writeValueWithResponse(new Uint8Array([0x03, 0x00, 0x01, 0xFF, midiNote & 0x7F, 0xFF]));
}

async function connectCube(tag) {
  // NOTE: connect button is a user gesture, safe to start audio here
  await ensureAudio();

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [TOIO_SERVICE_UUID] }],
  });

  device.addEventListener("gattserverdisconnected", () => {
    log(`Cube ${tag}: disconnected`);
    const curMidi = cubeState[tag].currentMidi;
    if (curMidi !== null && curMidi !== undefined) {
      userStop(curMidi);
      cubeState[tag].currentMidi = null;
    }
    clearPressed(tag);
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
  idCh.addEventListener("characteristicvaluechanged", async (ev) => {
    // Notifications are NOT guaranteed as user gesture, but audioCtx is already running after connect.
    const dv = ev.target.value;
    const msg = parseIdNotification(dv);

    if (msg.type === "standard") {
      const transpose = Number(transposeEl.value);
      const playable = getPlayableNoteFromToioId(msg.standardId, transpose);
      if (!playable) {
        log(`Cube ${tag}: StandardID=${msg.standardId} (unmapped)`);
        return;
      }

      // Keep playing while detected: switch only when note changes
      const prevMidi = cubeState[tag].currentMidi;
      const nextMidi = playable.midi;

      if (prevMidi !== nextMidi) {
        if (prevMidi !== null && prevMidi !== undefined) userStop(prevMidi);
        userStart(nextMidi);
        cubeState[tag].currentMidi = nextMidi;
      }

      pressKey(nextMidi, tag);

      if (cubeSoundEl?.checked) {
        cubePlayMidi(tag, nextMidi).catch(e => log(`Cube ${tag} sound error: ${e}`));
      }

      log(`Cube ${tag}: ID=${playable.toioId} => ${playable.noteName} angle=${msg.angle}`);
    }

    if (msg.type === "missed") {
      const curMidi = cubeState[tag].currentMidi;
      if (curMidi !== null && curMidi !== undefined) userStop(curMidi);
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
  userStart(midi);
}
function userRelease() {
  if (userPressedMidi === null) return;
  userStop(userPressedMidi);
  userPressedMidi = null;
  clearPressedUser();
}

// Piano keys
pianoEl.addEventListener("pointerdown", (e) => {
  const midi = getMidiFromTarget(e.target);
  if (midi === null) return;
  e.preventDefault();
  userAttack(midi).catch(err => log("User play error: " + err));
  pianoEl.setPointerCapture?.(e.pointerId);
});
pianoEl.addEventListener("pointerup", (e) => {
  userRelease();
  try { pianoEl.releasePointerCapture?.(e.pointerId); } catch {}
});
pianoEl.addEventListener("pointercancel", () => userRelease());
pianoEl.addEventListener("pointerleave", () => userRelease());

// Test Notes buttons
testNotesEl?.addEventListener("pointerdown", (e) => {
  const midi = getMidiFromTestButton(e.target);
  if (midi === null) return;
  e.preventDefault();
  userAttack(midi).catch(err => log("Test play error: " + err));
  const btn = e.target.closest("button");
  btn?.setPointerCapture?.(e.pointerId);
});
testNotesEl?.addEventListener("pointerup", (e) => {
  userRelease();
  const btn = e.target.closest("button");
  try { btn?.releasePointerCapture?.(e.pointerId); } catch {}
});
testNotesEl?.addEventListener("pointercancel", () => userRelease());
testNotesEl?.addEventListener("pointerleave", () => userRelease());

// --- UI events ------------------------------------------------
buildPiano();

document.querySelector("#btnA").addEventListener("click", () => connectCube("A").catch(e => log("Error A: " + e)));
document.querySelector("#btnB").addEventListener("click", () => connectCube("B").catch(e => log("Error B: " + e)));
document.querySelector("#btnStop").addEventListener("click", () => {
  userStopAll();
  for (const tag of ["A","B"]) {
    clearPressed(tag);
    cubeStopSound(tag).catch(() => {});
    cubeState[tag].currentMidi = null;
  }
  clearPressedUser();
});

instrumentEl?.addEventListener("change", () => {
  // Wave type changes will apply on next note start
  log(`Instrument(wave) changed: ${instrumentEl.value}`);
});

cubeSoundEl?.addEventListener("change", () => {
  if (!cubeSoundEl.checked) {
    cubeStopSound("A").catch(() => {});
    cubeStopSound("B").catch(() => {});
  } else {
    // resume cube speaker for current notes
    for (const tag of ["A","B"]) {
      const m = cubeState[tag].currentMidi;
      if (m !== null && m !== undefined) cubePlayMidi(tag, m).catch(() => {});
    }
  }
});