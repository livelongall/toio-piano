import { getPlayableNoteFromToioId } from "./toio_id_note_map.js";

/** toio BLE UUIDs */
const TOIO_SERVICE_UUID = "10b20100-5b3b-4571-9508-cf3efcd7bbae";
const ID_CHARACTERISTIC_UUID = "10b20101-5b3b-4571-9508-cf3efcd7bbae";
const LIGHT_CHARACTERISTIC_UUID = "10b20103-5b3b-4571-9508-cf3efcd7bbae";
const SOUND_CHARACTERISTIC_UUID = "10b20104-5b3b-4571-9508-cf3efcd7bbae";
// Motor characteristic for toio motors
const MOTOR_CHARACTERISTIC_UUID = "10b20102-5b3b-4571-9508-cf3efcd7bbae";

const logEl = document.querySelector("#log");
const log = (s) => { logEl.textContent = s + "\n" + logEl.textContent; };

const pianoEl = document.querySelector("#piano");
const transposeEl = document.querySelector("#transpose");
const instrumentEl = document.querySelector("#instrument");
const cubeSoundEl = document.querySelector("#cubeSound");
const testNotesEl = document.querySelector("#testNotes");
const btnLayoutEl = document.querySelector("#btnLayout");
const btnRun20El = document.querySelector("#btnRun20"); // may be null if index.html not updated

// --- GLOBAL SHIFT: lower everything by 1 octave (-12)
const GLOBAL_MIDI_SHIFT = -12;

// --- Piano UI -------------------------------------------------
const WHITE = new Set([0,2,4,5,7,9,11]);
function isBlack(midi){ return !WHITE.has(((midi % 12) + 12) % 12); }

const PIANO_MIN = 48;  // C3
const PIANO_MAX = 84;  // C6

function readKeyMetrics() {
  const rootStyle = getComputedStyle(document.documentElement);
  const whiteW = parseFloat(rootStyle.getPropertyValue("--whiteW")) || 38;
  const gap = parseFloat(rootStyle.getPropertyValue("--gap")) || 2;
  const blackOffset = parseFloat(rootStyle.getPropertyValue("--blackOffset")) || 26;
  return { whiteW, gap, blackOffset };
}

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
  const { whiteW, gap, blackOffset } = readKeyMetrics();
  const whiteIndexByMidi = new Map(whiteMidis.map((m,i)=>[m,i]));

  for (let m = PIANO_MIN; m <= PIANO_MAX; m++) {
    if (!isBlack(m)) continue;
    const leftWhite = m - 1;
    if (!whiteIndexByMidi.has(leftWhite)) continue;
    const i = whiteIndexByMidi.get(leftWhite);

    const black = document.createElement("div");
    black.className = "key black";
    black.dataset.midi = String(m);

    const leftPx = i * (whiteW + gap) + blackOffset;
    black.style.left = `${leftPx}px`;
    pianoEl.appendChild(black);
  }

  pianoEl.style.width = `${whiteMidis.length * (whiteW + gap)}px`;

  applyLayoutSizing();
}

function applyLayoutSizing() {
  // In vertical mode we rotate -90deg; adjust marginTop so it doesn't clip.
  const isVertical = document.body.classList.contains("vertical");
  if (!isVertical) {
    pianoEl.style.marginTop = "0px";
    return;
  }

  // After rotation, the element's visual height corresponds to its original width.
  // We add marginTop roughly equal to its width so the rotated content appears in view.
  const w = pianoEl.scrollWidth || pianoEl.getBoundingClientRect().width || 0;
  pianoEl.style.marginTop = `${Math.max(0, Math.floor(w) + 12)}px`;
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
let audioCtx = null;
let masterGain = null;
let filterNode = null;

function getWaveType() {
  const v = instrumentEl?.value || "acoustic_grand_piano";
  if (v === "church_organ") return "square";
  if (v === "flute") return "sine";
  if (v === "trumpet" || v === "synth_brass_1") return "sawtooth";
  if (v === "violin") return "sawtooth";
  if (v === "electric_piano_1") return "triangle";
  if (v === "marimba" || v === "vibraphone") return "triangle";
  if (v === "acoustic_guitar_nylon") return "triangle";
  return "sine";
}

async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });

    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.9;

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

function createVoice(freqHz) {
  const now = audioCtx.currentTime;

  const osc1 = audioCtx.createOscillator();
  const osc2 = audioCtx.createOscillator();
  osc1.type = getWaveType();
  osc2.type = getWaveType();

  osc1.frequency.setValueAtTime(freqHz, now);
  osc2.frequency.setValueAtTime(freqHz, now);
  osc2.detune.setValueAtTime(+7, now);

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.0, now);

  const a = 0.01;
  const s = 0.55;
  gain.gain.linearRampToValueAtTime(s, now + a);

  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(filterNode);

  osc1.start(now);
  osc2.start(now);

  return {
    stop: () => {
      const t = audioCtx.currentTime;
      const r = 0.08;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0.0, t + r);
      osc1.stop(t + r + 0.02);
      osc2.stop(t + r + 0.02);
    },
  };
}

const voices = new Map(); // midi(playMidi) -> voice
function startNote(midi) {
  if (!audioCtx) return;
  if (voices.has(midi)) return;
  const v = createVoice(midiToFreq(midi));
  voices.set(midi, v);
}
function stopNote(midi) {
  const v = voices.get(midi);
  if (!v) return;
  v.stop();
  voices.delete(midi);
}
function stopAllNotes() {
  for (const [m, v] of voices.entries()) {
    v.stop();
    voices.delete(m);
  }
}

function clampMidi(n) {
  const x = Number(n) | 0;
  return Math.max(0, Math.min(127, x));
}

// --- BLE / toio ID parsing -----------------------------------
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
  A: { device:null, idChar:null, lightChar:null, soundChar:null, motorChar:null, currentMidi:null, currentPlayMidi:null },
  B: { device:null, idChar:null, lightChar:null, soundChar:null, motorChar:null, currentMidi:null, currentPlayMidi:null },
};

function rgbForTag(tag) {
  return tag === "A" ? { r: 0, g: 180, b: 255 } : { r: 255, g: 120, b: 0 };
}
async function setCubeLamp(tag) {
  const ch = cubeState[tag].lightChar;
  if (!ch) return;
  const { r, g, b } = rgbForTag(tag);
  await ch.writeValueWithResponse(new Uint8Array([0x03, 0x00, 0x01, 0x01, r, g, b]));
}

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

// Motor control: forward both motors at speed
async function writeMotor(ch, bytes) {
  if (!ch) return;
  const data = new Uint8Array(bytes);

  // Motor characteristic is "Write without response"
  // so prefer writeValueWithoutResponse when available.
  if (ch.writeValueWithoutResponse) {
    await ch.writeValueWithoutResponse(data);
  } else {
    // fallback (some browsers expose only writeValue)
    await ch.writeValue(data);
  }
}

async function cubeRun(tag, speed = 20) {
  const ch = cubeState[tag].motorChar;
  const s = Math.max(0, Math.min(255, speed | 0));

  // Motor control (0x01): keep running until next command  [oai_citation:1‡toio.github.io](https://toio.github.io/toio-spec/docs/ble_motor/)
  // [0x01, leftId=1, leftDir=1(fwd), leftSpeed, rightId=2, rightDir=1(fwd), rightSpeed]
  await writeMotor(ch, [0x01, 0x01, 0x01, s, 0x02, 0x01, s]);
}

async function cubeStopMotor(tag) {
  const ch = cubeState[tag].motorChar;
  // speed=0 to stop
  await writeMotor(ch, [0x01, 0x01, 0x01, 0x00, 0x02, 0x01, 0x00]);
}

async function connectCube(tag) {
  await ensureAudio();

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [TOIO_SERVICE_UUID] }],
  });

  device.addEventListener("gattserverdisconnected", () => {
    log(`Cube ${tag}: disconnected`);
    // stop any playing note for this cube (use currentPlayMidi)
    const playMidi = cubeState[tag].currentPlayMidi;
    if (playMidi !== null && playMidi !== undefined) stopNote(playMidi);
    cubeState[tag].currentMidi = null;
    cubeState[tag].currentPlayMidi = null;
    clearPressed(tag);
    cubeStopSound(tag).catch(() => {});
    // also try stop motor
    cubeStopMotor(tag).catch(() => {});
  });

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(TOIO_SERVICE_UUID);

  const idCh = await service.getCharacteristic(ID_CHARACTERISTIC_UUID);
  const lightCh = await service.getCharacteristic(LIGHT_CHARACTERISTIC_UUID);
  const soundCh = await service.getCharacteristic(SOUND_CHARACTERISTIC_UUID);
  // motor characteristic
  let motorCh = null;
  try {
    motorCh = await service.getCharacteristic(MOTOR_CHARACTERISTIC_UUID);
  } catch (e) {
    // some devices or firmwares may not expose; log and continue
    log(`Cube ${tag}: motor characteristic not available (${e})`);
  }

  cubeState[tag].device = device;
  cubeState[tag].idChar = idCh;
  cubeState[tag].lightChar = lightCh;
  cubeState[tag].soundChar = soundCh;
  cubeState[tag].motorChar = motorCh;

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

      const uiMidi = playable.midi; // for UI/highlight
      const playMidi = clampMidi(uiMidi + GLOBAL_MIDI_SHIFT); // actual sounding midi

      const prevPlay = cubeState[tag].currentPlayMidi;

      if (prevPlay !== playMidi) {
        if (prevPlay !== null && prevPlay !== undefined) stopNote(prevPlay);
        startNote(playMidi);
        cubeState[tag].currentPlayMidi = playMidi;
        cubeState[tag].currentMidi = uiMidi;
      }

      // UI highlight uses uiMidi
      pressKey(uiMidi, tag);

      // Cube speaker: send actual sounding midi
      if (cubeSoundEl?.checked) {
        cubePlayMidi(tag, playMidi).catch(e => log(`Cube ${tag} sound error: ${e}`));
      }

      log(`Cube ${tag}: ID=${playable.toioId} => ${playable.noteName} (ui:${uiMidi} play:${playMidi}) angle=${msg.angle}`);
    }

    if (msg.type === "missed") {
      const playMidi = cubeState[tag].currentPlayMidi;
      if (playMidi !== null && playMidi !== undefined) stopNote(playMidi);
      cubeState[tag].currentMidi = null;
      cubeState[tag].currentPlayMidi = null;
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
let userPressedPlayMidi = null;

async function userAttack(midi) {
  await ensureAudio();
  userPressedMidi = midi; // UI midi
  const playMidi = clampMidi(midi + GLOBAL_MIDI_SHIFT);
  userPressedPlayMidi = playMidi;
  pressKeyUser(midi);
  startNote(playMidi);
}
function userRelease() {
  if (userPressedMidi === null) return;
  stopNote(userPressedPlayMidi);
  userPressedMidi = null;
  userPressedPlayMidi = null;
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

// --- Layout toggle (B) ---------------------------------------
btnLayoutEl?.addEventListener("click", () => {
  const v = document.body.classList.toggle("vertical");
  btnLayoutEl.textContent = v ? "Layout: Vertical" : "Layout: Horizontal";
  applyLayoutSizing();
});

// Run(20) button: drive connected cubes at speed 20
btnRun20El?.addEventListener("click", async () => {
  // If button not present, nothing happens
  try {
    let any = false;
    if (cubeState.A.device) {
      await cubeRun("A", 20);
      any = true;
    }
    if (cubeState.B.device) {
      await cubeRun("B", 20);
      any = true;
    }
    log(any ? "Run: speed 20" : "No cubes connected to run");
  } catch (e) {
    log("Run error: " + e);
  }
});

// --- UI events ------------------------------------------------
buildPiano();

document.querySelector("#btnA").addEventListener("click", () => connectCube("A").catch(e => log("Error A: " + e)));
document.querySelector("#btnB").addEventListener("click", () => connectCube("B").catch(e => log("Error B: " + e)));

document.querySelector("#btnStop").addEventListener("click", () => {
  // stop audio notes
  stopAllNotes();
  // stop cube sounds & motors, clear UI
  for (const tag of ["A","B"]) {
    clearPressed(tag);
    cubeStopSound(tag).catch(() => {});
    cubeStopMotor(tag).catch(() => {});
    cubeState[tag].currentMidi = null;
    cubeState[tag].currentPlayMidi = null;
  }
  clearPressedUser();
});

instrumentEl?.addEventListener("change", () => {
  log(`Instrument(wave) changed: ${instrumentEl.value}`);
});

cubeSoundEl?.addEventListener("change", () => {
  if (!cubeSoundEl.checked) {
    cubeStopSound("A").catch(() => {});
    cubeStopSound("B").catch(() => {});
  } else {
    for (const tag of ["A","B"]) {
      const play = cubeState[tag].currentPlayMidi;
      if (play !== null && play !== undefined) cubePlayMidi(tag, play).catch(() => {});
    }
  }
});

// Rebuild on resize/orientation changes (A)
let resizeTimer = null;
function scheduleRebuild() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => buildPiano(), 120);
}
window.addEventListener("resize", scheduleRebuild);
window.addEventListener("orientationchange", scheduleRebuild);