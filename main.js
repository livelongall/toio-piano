import * as Tone from "https://esm.sh/tone@14.8.49";
import { getPlayableNoteFromToioId } from "./toio_id_note_map.js";

/** toio BLE UUIDs */
const TOIO_SERVICE_UUID = "10b20100-5b3b-4571-9508-cf3efcd7bbae";
const ID_CHARACTERISTIC_UUID = "10b20101-5b3b-4571-9508-cf3efcd7bbae";

const logEl = document.querySelector("#log");
const log = (s) => { logEl.textContent = s + "\n" + logEl.textContent; };

const pianoEl = document.querySelector("#piano");
const transposeEl = document.querySelector("#transpose");

let sampler = null;
let isAudioReady = false;

// --- Piano UI -------------------------------------------------
const WHITE = new Set([0,2,4,5,7,9,11]);
function isBlack(midi){ return !WHITE.has(((midi%12)+12)%12); }

const PIANO_MIN = 48;  // C3
const PIANO_MAX = 84;  // C6

function buildPiano() {
  pianoEl.innerHTML = "";
  // white keys layout
  const whiteMidis = [];
  for (let m = PIANO_MIN; m <= PIANO_MAX; m++) if (!isBlack(m)) whiteMidis.push(m);

  // render white keys
  whiteMidis.forEach((m) => {
    const key = document.createElement("div");
    key.className = "key white";
    key.dataset.midi = String(m);
    pianoEl.appendChild(key);
  });

  // render black keys positioned relative to preceding white key
  // For each black key, find its left white index and place on top.
  const whiteIndexByMidi = new Map(whiteMidis.map((m,i)=>[m,i]));
  for (let m = PIANO_MIN; m <= PIANO_MAX; m++) {
    if (!isBlack(m)) continue;
    // black key sits between m-1 (white) and m+1 (white) except E-F/B-C gaps
    const leftWhite = m - 1;
    if (!whiteIndexByMidi.has(leftWhite)) continue;
    const i = whiteIndexByMidi.get(leftWhite);

    const black = document.createElement("div");
    black.className = "key black";
    black.dataset.midi = String(m);

    // position: align near right side of left white key
    const leftPx = i * (38 + 2) + 26; // tweak
    black.style.left = `${leftPx}px`;
    pianoEl.appendChild(black);
  }

  // set container width
  pianoEl.style.width = `${whiteMidis.length * (38 + 2)}px`;
}

function clearPressed(cubeTag){
  pianoEl.querySelectorAll(`.pressed${cubeTag}`).forEach(el => el.classList.remove(`pressed${cubeTag}`));
}

function pressKey(midi, cubeTag){
  clearPressed(cubeTag);
  const el = pianoEl.querySelector(`[data-midi="${midi}"]`);
  if (!el) return;
  el.classList.add(`pressed${cubeTag}`);
}

// --- Audio ----------------------------------------------------
async function ensureAudio() {
  if (isAudioReady) return;

  await Tone.start(); // must be called in user gesture
  Tone.getContext().lookAhead = 0.0;

  // Rich piano sampler (multi-sample). This set is light enough but still “pianoっぽい”。
  // If you want even richer: increase sampled notes or host your own wav/mp3 set.
  sampler = new Tone.Sampler({
    urls: {
      "C2": "C2.mp3",
      "E2": "E2.mp3",
      "G2": "G2.mp3",
      "C3": "C3.mp3",
      "E3": "E3.mp3",
      "G3": "G3.mp3",
      "C4": "C4.mp3",
      "E4": "E4.mp3",
      "G4": "G4.mp3",
      "C5": "C5.mp3",
      "E5": "E5.mp3",
      "G5": "G5.mp3",
      "C6": "C6.mp3",
    },
    release: 0.8,
    baseUrl: "https://tonejs.github.io/audio/salamander/",
  }).toDestination();

  isAudioReady = true;
  log("Audio ready (Tone.js Sampler)");
}

function stopAll() {
  try { sampler?.releaseAll?.(); } catch {}
  cubeState.A.currentNote = null;
  cubeState.B.currentNote = null;
  clearPressed("A");
  clearPressed("B");
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
  A: { device:null, char:null, currentNote:null },
  B: { device:null, char:null, currentNote:null },
};

async function connectCube(tag) {
  await ensureAudio();

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [TOIO_SERVICE_UUID] }],
  });

  device.addEventListener("gattserverdisconnected", () => {
    log(`Cube ${tag}: disconnected`);
    if (cubeState[tag].currentNote) {
      sampler?.triggerRelease?.(cubeState[tag].currentNote);
      cubeState[tag].currentNote = null;
      clearPressed(tag);
    }
  });

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(TOIO_SERVICE_UUID);
  const ch = await service.getCharacteristic(ID_CHARACTERISTIC_UUID);

  await ch.startNotifications();
  ch.addEventListener("characteristicvaluechanged", (ev) => {
    const dv = ev.target.value;
    const msg = parseIdNotification(dv);

    if (msg.type === "standard") {
      const transpose = Number(transposeEl.value);
      const playable = getPlayableNoteFromToioId(msg.standardId, transpose);
      if (!playable) {
        log(`Cube ${tag}: StandardID=${msg.standardId} (unmapped)`);
        return;
      }

      // Release previous note (per cube), then attack new note
      const prev = cubeState[tag].currentNote;
      const next = playable.noteName; // e.g., C4
      if (prev && prev !== next) sampler?.triggerRelease?.(prev);

      if (prev !== next) {
        sampler?.triggerAttack?.(next);
        cubeState[tag].currentNote = next;
      }

      // UI highlight (midi is transposed already)
      pressKey(playable.midi, tag);

      log(`Cube ${tag}: ID=${playable.toioId} => ${playable.noteName} (${Math.round(playable.freq_hz)}Hz) angle=${msg.angle}`);
    }

    if (msg.type === "missed") {
      const cur = cubeState[tag].currentNote;
      if (cur) sampler?.triggerRelease?.(cur);
      cubeState[tag].currentNote = null;
      clearPressed(tag);
      log(`Cube ${tag}: missed`);
    }
  });

  cubeState[tag].device = device;
  cubeState[tag].char = ch;
  log(`Cube ${tag}: connected`);
}

// --- UI events ------------------------------------------------
buildPiano();

document.querySelector("#btnA").addEventListener("click", () => connectCube("A").catch(e => log("Error A: " + e)));
document.querySelector("#btnB").addEventListener("click", () => connectCube("B").catch(e => log("Error B: " + e)));
document.querySelector("#btnStop").addEventListener("click", () => stopAll());