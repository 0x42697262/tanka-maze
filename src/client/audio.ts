// Dedicated Web Audio API manager for zero-latency sound effects and gapless looping.

export const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
const buffers = new Map<string, AudioBuffer>();
import { state } from "./state.js";

export function loadAudio(name: string, url: string) {
  fetch(url)
    .then((res) => res.arrayBuffer())
    .then((data) => audioCtx.decodeAudioData(data))
    .then((buffer) => buffers.set(name, buffer))
    .catch((e) => console.warn(`Failed to load audio: ${name}`, e));
}

// Preload sound effects into memory
loadAudio("pew", "/pew.ogg");
loadAudio("explosion", "/explosion.ogg");
loadAudio("vroom", "/vroom.ogg");
loadAudio("reloading", "/reloading.ogg");
loadAudio("powerup", "/powerup.ogg");
loadAudio("oof", "/oof.ogg");
loadAudio("first_blood", "/first_blood.ogg");
loadAudio("double_kill", "/double_kill.ogg");
loadAudio("triple_kill", "/triple_kill.ogg");
loadAudio("maniac", "/maniac.ogg");
loadAudio("savage", "/savage.ogg");
loadAudio("win", "/win.ogg");
loadAudio("lose", "/lose.ogg");
loadAudio("bgm", "/bgm.ogg");

// Browsers require a user gesture to unlock audio contexts
const unlockAudio = () => {
  if (audioCtx.state === "suspended") audioCtx.resume();
  document.removeEventListener("pointerdown", unlockAudio);
  document.removeEventListener("keydown", unlockAudio);
};
document.addEventListener("pointerdown", unlockAudio);
document.addEventListener("keydown", unlockAudio);

export let globalSfxVolume = 1.0;
let vroomGainNode: GainNode | null = null;

export function setSfxVolume(vol: number) {
  globalSfxVolume = vol;
  if (vroomGainNode) {
    vroomGainNode.gain.value = 0.2 * globalSfxVolume;
  }
}

/** Instantly play a sound effect from memory. `rate` is playback speed (1 = normal). */
export function playSfx(name: string, volume = 1.0, rate = 1.0) {
  if (state.realisticEnabled) {
    if (name === "pew") {
      playRealisticCannon(volume, rate);
      return;
    }
    const buffer = buffers.get(name);
    if (buffer) {
      if (audioCtx.state === "suspended") audioCtx.resume();
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = volume * globalSfxVolume;
      source.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      source.start();
      return;
    }
  }

  if (state.modernEnabled) {
    if (name === "pew") {
      playSynthPewModern(volume, rate);
      return;
    }
    if (name === "explosion") {
      playSynthExplosionModern(volume);
      return;
    }
    if (name === "powerup") {
      playSynthPowerupModern(volume);
      return;
    }
    if (name === "oof") {
      playSynthOofModern(volume);
      return;
    }
    if (name === "reloading") {
      playSynthReloadingModern(volume);
      return;
    }
    if (name === "win") {
      playSynthWinModern(volume);
      return;
    }
    if (name === "lose") {
      playSynthLoseModern(volume);
      return;
    }
  }

  if (state.battleCityEnabled) {
    if (name === "pew") {
      playSynthPew8Bit(volume, rate);
      return;
    }
    if (name === "explosion") {
      playSynthExplosion8Bit(volume);
      return;
    }
    if (name === "powerup") {
      playSynthPowerup8Bit(volume);
      return;
    }
    if (name === "oof") {
      playSynthOof8Bit(volume);
      return;
    }
    if (name === "reloading") {
      playSynthReloading8Bit(volume);
      return;
    }
    if (name === "win") {
      playSynthWin8Bit(volume);
      return;
    }
    if (name === "lose") {
      playSynthLose8Bit(volume);
      return;
    }
  }

  if (name === "pew") {
    playSynthPew(volume, rate);
    return;
  }

  const buffer = buffers.get(name);
  if (!buffer) return;
  if (audioCtx.state === "suspended") audioCtx.resume();

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = volume * globalSfxVolume;

  source.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  source.start();
}

/** Synthesize a massive, realistic military tank cannon blast dynamically using multi-layered Web Audio nodes */
function playRealisticCannon(volume: number, rate = 1.0) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;

  // 1. Distortion curve to simulate raw explosion pressure saturation
  const shaper = audioCtx.createWaveShaper();
  const makeDistortionCurve = (amount = 20) => {
    const k = amount;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  };
  shaper.curve = makeDistortionCurve(15);
  shaper.oversample = "4x";

  // 2. Layer A: Bass Shockwave (Low-frequency sine wave sweep)
  const bassOsc = audioCtx.createOscillator();
  bassOsc.type = "sine";
  bassOsc.frequency.setValueAtTime(140 * rate, now);
  // Extremely rapid drop to simulate the shockwave expansion
  bassOsc.frequency.exponentialRampToValueAtTime(25 * rate, now + 0.18 / rate);

  const bassGain = audioCtx.createGain();
  bassGain.gain.setValueAtTime(1.0, now);
  bassGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35 / rate);

  bassOsc.connect(bassGain);
  
  // 3. Layer B: Muzzle Blast (White noise burst filtered with a low-pass/band-pass combination)
  const bufferSize = Math.max(100, Math.floor(audioCtx.sampleRate * (0.35 / rate)));
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    // Noise shaped with exponential decay to mimic combustion envelope
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.22));
  }
  const noiseSource = audioCtx.createBufferSource();
  noiseSource.buffer = buffer;

  const noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = "lowpass";
  // Filter sweeps down to cut high-end "hiss", leaving the thunderous body
  noiseFilter.frequency.setValueAtTime(450 * rate, now);
  noiseFilter.frequency.exponentialRampToValueAtTime(70 * rate, now + 0.35 / rate);
  noiseFilter.Q.value = 1.0;

  const noiseGain = audioCtx.createGain();
  noiseGain.gain.setValueAtTime(0.9, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35 / rate);

  noiseSource.connect(noiseFilter);
  noiseFilter.connect(noiseGain);

  // 4. Layer C: Initial Gunpowder Crack (High-frequency transient)
  const crackBuffer = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * (0.05 / rate)), audioCtx.sampleRate);
  const crackData = crackBuffer.getChannelData(0);
  for (let i = 0; i < crackData.length; i++) {
    crackData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (crackData.length * 0.15));
  }
  const crackSource = audioCtx.createBufferSource();
  crackSource.buffer = crackBuffer;

  const crackFilter = audioCtx.createBiquadFilter();
  crackFilter.type = "highpass";
  crackFilter.frequency.setValueAtTime(1000 * rate, now);

  const crackGain = audioCtx.createGain();
  crackGain.gain.setValueAtTime(0.5, now);
  crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05 / rate);

  crackSource.connect(crackFilter);
  crackFilter.connect(crackGain);

  // 5. Master combination and gain control
  const masterGain = audioCtx.createGain();
  masterGain.gain.value = volume * globalSfxVolume * 1.2; // Slightly boosted for extra punch

  // Bass connects directly to master (clean low end)
  bassGain.connect(masterGain);

  // Muzzle noise and crack go through the waveshaper distortion to add saturation/explosiveness
  noiseGain.connect(shaper);
  crackGain.connect(shaper);
  shaper.connect(masterGain);

  // Output to speaker
  masterGain.connect(audioCtx.destination);

  // Start playback
  bassOsc.start(now);
  bassOsc.stop(now + 0.35 / rate);
  noiseSource.start(now);
  noiseSource.stop(now + 0.35 / rate);
  crackSource.start(now);
  crackSource.stop(now + 0.05 / rate);
}

/** Synthesize a retro arcade gun shot sound dynamically using oscillators and noise filter envelopes */
function playSynthPew(volume: number, rate = 1.0) {
  if (audioCtx.state === "suspended") audioCtx.resume();

  const now = audioCtx.currentTime;
  const duration = 0.15 / rate;

  // 1. Oscillator for the frequency-swept core punch
  const osc = audioCtx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(850 * rate, now);
  osc.frequency.exponentialRampToValueAtTime(60 * rate, now + duration);

  // 2. White noise for the explosive crunch
  const bufferSize = Math.max(100, Math.floor(audioCtx.sampleRate * duration));
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;

  // 3. Bandpass filter to sculpt the noise explosion
  const filter = audioCtx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(1000 * rate, now);
  filter.frequency.exponentialRampToValueAtTime(120 * rate, now + duration);
  filter.Q.value = 1.5;

  // 4. Envelopes for volume decay
  const oscGain = audioCtx.createGain();
  oscGain.gain.setValueAtTime(0.4, now);
  oscGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

  const noiseGain = audioCtx.createGain();
  noiseGain.gain.setValueAtTime(0.6, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + (0.1 / rate));

  const mainGain = audioCtx.createGain();
  mainGain.gain.value = volume * globalSfxVolume;

  // Connections
  osc.connect(oscGain);
  oscGain.connect(mainGain);

  noise.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(mainGain);

  mainGain.connect(audioCtx.destination);

  osc.start(now);
  osc.stop(now + duration);
  noise.start(now);
  noise.stop(now + duration);
}

/* ---- 8-Bit NES Synthesizers for Battle City mode ---- */
function playSynthPew8Bit(volume: number, rate = 1.0) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const duration = 0.1 / rate;
  const osc = audioCtx.createOscillator();
  osc.type = "square"; // NES Square pulse wave
  osc.frequency.setValueAtTime(600 * rate, now);
  osc.frequency.linearRampToValueAtTime(100 * rate, now + duration);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.25 * volume * globalSfxVolume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + duration);
}

function playSynthExplosion8Bit(volume: number) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const duration = 0.35;
  const bufferSize = audioCtx.sampleRate * duration;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  let lastVal = 0;
  // NES noise emulation: downsampled random steps
  for (let i = 0; i < bufferSize; i++) {
    if (i % 8 === 0) lastVal = Math.random() * 2 - 1;
    data[i] = lastVal;
  }
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  const filter = audioCtx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(300, now);
  filter.frequency.exponentialRampToValueAtTime(30, now + duration);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.5 * volume * globalSfxVolume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);
  noise.start(now);
  noise.stop(now + duration);
}

function playSynthPowerup8Bit(volume: number) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  osc.type = "square";
  const arpeggio = [261.63, 329.63, 392.00, 523.25, 659.25, 783.99, 1046.50]; // C4, E4, G4, C5, E5, G5, C6
  const stepTime = 0.05;
  arpeggio.forEach((freq, idx) => {
    osc.frequency.setValueAtTime(freq, now + idx * stepTime);
  });
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.15 * volume * globalSfxVolume, now);
  gain.gain.setValueAtTime(0.15 * volume * globalSfxVolume, now + (arpeggio.length - 1) * stepTime);
  gain.gain.exponentialRampToValueAtTime(0.001, now + arpeggio.length * stepTime);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + arpeggio.length * stepTime);
}

function playSynthOof8Bit(volume: number) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const duration = 0.08;
  const osc = audioCtx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(150, now);
  osc.frequency.linearRampToValueAtTime(50, now + duration);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.3 * volume * globalSfxVolume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + duration);
}

function playSynthReloading8Bit(volume: number) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(800, now);
  osc.frequency.setValueAtTime(1200, now + 0.06);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.12 * volume * globalSfxVolume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.12);
}

function playSynthWin8Bit(volume: number) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const notes = [523.25, 523.25, 523.25, 523.25, 659.25, 587.33, 659.25, 783.99, 1046.50]; // C5 C5 C5 C5 E5 D5 E5 G5 C6
  const durations = [0.1, 0.1, 0.1, 0.2, 0.2, 0.1, 0.1, 0.1, 0.6];
  let time = now;
  notes.forEach((freq, idx) => {
    const osc = audioCtx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(freq, time);
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.18 * volume * globalSfxVolume, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + durations[idx] - 0.02);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(time);
    osc.stop(time + durations[idx]);
    time += durations[idx];
  });
}

function playSynthLose8Bit(volume: number) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const notes = [392.00, 370.00, 349.23, 311.13, 293.66, 261.63]; // G4 F#4 F4 D#4 D4 C4
  const durations = [0.15, 0.15, 0.15, 0.2, 0.2, 0.8];
  let time = now;
  notes.forEach((freq, idx) => {
    const osc = audioCtx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, time);
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.3 * volume * globalSfxVolume, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + durations[idx] - 0.02);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(time);
    osc.stop(time + durations[idx]);
    time += durations[idx];
  });
}

/* ---- Modern 4K Sci-Fi Synthesizers ---- */
function playSynthPewModern(volume: number, rate = 1.0) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const duration = 0.18 / rate;
  const osc = audioCtx.createOscillator();
  osc.type = "sawtooth"; // futuristic energy discharge
  osc.frequency.setValueAtTime(1400 * rate, now);
  osc.frequency.exponentialRampToValueAtTime(100 * rate, now + duration);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.22 * volume * globalSfxVolume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + duration);
}

function playSynthExplosionModern(volume: number) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const duration = 0.5;
  
  // 1. Deep Sub Bass drop
  const osc = audioCtx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(80, now);
  osc.frequency.linearRampToValueAtTime(20, now + duration);
  const oscGain = audioCtx.createGain();
  oscGain.gain.setValueAtTime(0.6 * volume * globalSfxVolume, now);
  oscGain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.connect(oscGain);
  oscGain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + duration);

  // 2. Futuristic noise capacitor blast
  const bufferSize = audioCtx.sampleRate * 0.35;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  const filter = audioCtx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(350, now);
  const noiseGain = audioCtx.createGain();
  noiseGain.gain.setValueAtTime(0.45 * volume * globalSfxVolume, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
  noise.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(audioCtx.destination);
  noise.start(now);
  noise.stop(now + 0.35);
}

function playSynthPowerupModern(volume: number) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const duration = 0.45;
  const osc1 = audioCtx.createOscillator();
  const osc2 = audioCtx.createOscillator();
  osc1.type = "sine";
  osc2.type = "triangle";
  osc1.frequency.setValueAtTime(320, now);
  osc1.frequency.exponentialRampToValueAtTime(960, now + duration);
  osc2.frequency.setValueAtTime(160, now);
  osc2.frequency.exponentialRampToValueAtTime(480, now + duration);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.18 * volume * globalSfxVolume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(audioCtx.destination);
  osc1.start(now);
  osc2.start(now);
  osc1.stop(now + duration);
  osc2.stop(now + duration);
}

function playSynthOofModern(volume: number) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const duration = 0.12;
  const osc = audioCtx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(450, now);
  osc.frequency.exponentialRampToValueAtTime(220, now + duration);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.25 * volume * globalSfxVolume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + duration);
}

function playSynthReloadingModern(volume: number) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const duration = 0.15;
  const osc = audioCtx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(240, now);
  osc.frequency.exponentialRampToValueAtTime(640, now + duration);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.1 * volume * globalSfxVolume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + duration);
}

function playSynthWinModern(volume: number) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const notes = [293.66, 349.23, 440.00, 523.25, 587.33, 698.46, 880.00]; // Dm9 chord sweep
  notes.forEach((freq, idx) => {
    const osc = audioCtx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now + idx * 0.08);
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.15 * volume * globalSfxVolume, now + idx * 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now + idx * 0.08);
    osc.stop(now + 0.6);
  });
}

function playSynthLoseModern(volume: number) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(90, now);
  osc.frequency.exponentialRampToValueAtTime(30, now + 1.2);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.35 * volume * globalSfxVolume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 1.2);
}



let vroomSource: any = null;
export let isVroomPlaying = false;

export function playVroom() {
  if (isVroomPlaying) return;
  
  if (state.modernEnabled) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    vroomSource = audioCtx.createOscillator();
    vroomSource.type = "sine"; // Electric hover/sine whine
    vroomSource.frequency.setValueAtTime(80, audioCtx.currentTime);
    
    vroomGainNode = audioCtx.createGain();
    vroomGainNode.gain.setValueAtTime(0.08 * globalSfxVolume, audioCtx.currentTime);
    
    vroomSource.connect(vroomGainNode);
    vroomGainNode.connect(audioCtx.destination);
    vroomSource.start();
    isVroomPlaying = true;
    return;
  }
  
  if (state.battleCityEnabled) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    vroomSource = audioCtx.createOscillator();
    vroomSource.type = "triangle"; // NES triangle bass engine sound
    vroomSource.frequency.setValueAtTime(55, audioCtx.currentTime);
    
    vroomGainNode = audioCtx.createGain();
    vroomGainNode.gain.setValueAtTime(0.12 * globalSfxVolume, audioCtx.currentTime);
    
    vroomSource.connect(vroomGainNode);
    vroomGainNode.connect(audioCtx.destination);
    vroomSource.start();
    isVroomPlaying = true;
    return;
  }

  const buffer = buffers.get("vroom");
  if (!buffer) return;
  
  if (audioCtx.state === "suspended") audioCtx.resume();
  vroomSource = audioCtx.createBufferSource();
  vroomSource.buffer = buffer;
  vroomSource.loop = true;
  
  vroomGainNode = audioCtx.createGain();
  // For realistic military skin, let's make it a heavier/lower diesel tank rumble
  const baseVolume = state.realisticEnabled ? 0.20 : 0.12;
  const basePitch = state.realisticEnabled ? 0.60 : 0.75; 
  vroomGainNode.gain.value = baseVolume * globalSfxVolume;
  vroomSource.playbackRate.value = basePitch;
  
  vroomSource.connect(vroomGainNode);
  vroomGainNode.connect(audioCtx.destination);
  vroomSource.start();
  isVroomPlaying = true;
}

export function pauseVroom() {
  if (!isVroomPlaying || !vroomSource) return;
  vroomSource.stop();
  vroomSource.disconnect();
  vroomSource = null;
  vroomGainNode = null;
  isVroomPlaying = false;
}

export function updateVroom(isMoving: boolean, hasBoost: boolean) {
  if (!isVroomPlaying || !vroomSource || !vroomGainNode) return;
  
  if (state.realisticEnabled) {
    let targetPitch = 0.60; // Idle heavy diesel pitch
    let targetGain = 0.20;
    
    if (isMoving) {
      if (hasBoost) {
        targetPitch = 1.15; // Full-rev heavy tank
        targetGain = 0.35;
      } else {
        targetPitch = 0.85; // Cruising heavy tank
        targetGain = 0.25;
      }
    }
    
    const now = audioCtx.currentTime;
    vroomSource.playbackRate.setTargetAtTime(targetPitch, now, 0.15);
    vroomGainNode.gain.setTargetAtTime(targetGain * globalSfxVolume, now, 0.15);
    return;
  }

  if (state.modernEnabled) {
    let targetPitch = 70; // Idle electric engine hum
    let targetGain = 0.08;
    
    if (isMoving) {
      if (hasBoost) {
        targetPitch = 160; // Hyper boost electric hum
        targetGain = 0.22;
      } else {
        targetPitch = 110; // Active hover hum
        targetGain = 0.15;
      }
    }
    
    const now = audioCtx.currentTime;
    vroomSource.frequency.setTargetAtTime(targetPitch, now, 0.1);
    vroomGainNode.gain.setTargetAtTime(targetGain * globalSfxVolume, now, 0.1);
    return;
  }
  
  if (state.battleCityEnabled) {
    let targetPitch = 45; // Idle low pitch (Hz)
    let targetGain = 0.12;
    
    if (isMoving) {
      if (hasBoost) {
        targetPitch = 90; // Speed boost (Hz)
        targetGain = 0.28;
      } else {
        targetPitch = 65; // Moving pitch (Hz)
        targetGain = 0.2;
      }
    }
    
    const now = audioCtx.currentTime;
    vroomSource.frequency.setTargetAtTime(targetPitch, now, 0.1);
    vroomGainNode.gain.setTargetAtTime(targetGain * globalSfxVolume, now, 0.1);
    return;
  }

  let targetPitch = 0.75; // Quiet low pitch for idle
  let targetGain = 0.12;
  
  if (isMoving) {
    if (hasBoost) {
      targetPitch = 1.35; // High pitch/rev for speed boost
      targetGain = 0.3;
    } else {
      targetPitch = 1.05; // Standard acceleration pitch
      targetGain = 0.2;
    }
  }
  
  const now = audioCtx.currentTime;
  vroomSource.playbackRate.setTargetAtTime(targetPitch, now, 0.1);
  vroomGainNode.gain.setTargetAtTime(targetGain * globalSfxVolume, now, 0.1);
}

export let globalBgmVolume = 0.5;
let bgmSource: AudioBufferSourceNode | null = null;
let bgmGainNode: GainNode | null = null;
export let isBgmPlaying = false;
let synthBgmInterval: ReturnType<typeof setInterval> | null = null;

export function setBgmVolume(vol: number) {
  globalBgmVolume = vol;
  if (bgmGainNode) {
    bgmGainNode.gain.value = globalBgmVolume;
  }
}

let realisticBgmInterval: ReturnType<typeof setInterval> | null = null;

function playRealisticBgmLoop() {
  if (realisticBgmInterval) return;
  let step = 0;

  // Root note frequencies for the drone/chords: D, Bb, C, A
  const roots = [58.27, 73.42, 65.41, 55.00]; 
  // Horn melody notes: D3, F3, G3, A3, Bb3, A3, G3, F3
  const melody = [146.83, 174.61, 196.00, 220.00, 233.08, 220.00, 196.00, 174.61];

  realisticBgmInterval = setInterval(() => {
    if (audioCtx.state === "suspended") audioCtx.resume();
    const now = audioCtx.currentTime;

    const sequenceStep = step % 16;
    const chordIndex = Math.floor(step / 8) % roots.length;
    const currentRoot = roots[chordIndex];

    // 1. Deep Bass Drone (re-triggered every 8 steps to maintain the rumble)
    if (sequenceStep === 0) {
      const droneOsc = audioCtx.createOscillator();
      droneOsc.type = "triangle";
      droneOsc.frequency.setValueAtTime(currentRoot, now);
      droneOsc.frequency.linearRampToValueAtTime(currentRoot * 0.98, now + 2.3);

      const droneFilter = audioCtx.createBiquadFilter();
      droneFilter.type = "lowpass";
      droneFilter.frequency.setValueAtTime(120, now);

      const droneGain = audioCtx.createGain();
      droneGain.gain.setValueAtTime(0.001, now);
      droneGain.gain.linearRampToValueAtTime(0.22 * globalBgmVolume, now + 0.5);
      droneGain.gain.exponentialRampToValueAtTime(0.001, now + 2.3);

      droneOsc.connect(droneFilter);
      droneFilter.connect(droneGain);
      droneGain.connect(audioCtx.destination);
      droneOsc.start(now);
      droneOsc.stop(now + 2.4);
    }

    // 2. Orchestral Timpani Drum Hit (on beat 1 and 3 of the bar: step 0, 8)
    if (sequenceStep === 0 || sequenceStep === 8) {
      // Noise burst for the impact rumble
      const timpBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.4, audioCtx.sampleRate);
      const timpData = timpBuffer.getChannelData(0);
      for (let i = 0; i < timpData.length; i++) {
        timpData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (audioCtx.sampleRate * 0.1));
      }
      const timpSource = audioCtx.createBufferSource();
      timpSource.buffer = timpBuffer;

      const timpFilter = audioCtx.createBiquadFilter();
      timpFilter.type = "lowpass";
      timpFilter.frequency.setValueAtTime(90, now);
      timpFilter.frequency.exponentialRampToValueAtTime(30, now + 0.3);
      timpFilter.Q.value = 4.0;

      const timpGain = audioCtx.createGain();
      timpGain.gain.setValueAtTime(0.28 * globalBgmVolume, now);
      timpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

      timpSource.connect(timpFilter);
      timpFilter.connect(timpGain);
      timpGain.connect(audioCtx.destination);
      timpSource.start(now);
      timpSource.stop(now + 0.4);
    }

    // 3. Snare March (Military parade rimshots and rolls)
    const isSnareAccent = sequenceStep === 4 || sequenceStep === 12;
    const isSnareTap = sequenceStep === 2 || sequenceStep === 6 || sequenceStep === 10 || sequenceStep === 14;
    
    if (isSnareAccent || isSnareTap) {
      const snareLength = isSnareAccent ? 0.08 : 0.04;
      const snareVolume = (isSnareAccent ? 0.10 : 0.04) * globalBgmVolume;
      const snareBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * snareLength, audioCtx.sampleRate);
      const snareData = snareBuffer.getChannelData(0);
      for (let i = 0; i < snareData.length; i++) {
        snareData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (snareData.length * 0.35));
      }
      const snareSource = audioCtx.createBufferSource();
      snareSource.buffer = snareBuffer;

      const snareFilter = audioCtx.createBiquadFilter();
      snareFilter.type = "bandpass";
      snareFilter.frequency.setValueAtTime(isSnareAccent ? 1200 : 1500, now);
      snareFilter.Q.value = 1.8;

      const snareGain = audioCtx.createGain();
      snareGain.gain.setValueAtTime(snareVolume, now);
      snareGain.gain.exponentialRampToValueAtTime(0.001, now + snareLength);

      snareSource.connect(snareFilter);
      snareFilter.connect(snareGain);
      snareGain.connect(audioCtx.destination);
      snareSource.start(now);
      snareSource.stop(now + snareLength);
    }

    // 4. Cinematic Horn/Brass Swell (triggers every 16 steps)
    if (sequenceStep === 0) {
      const hornIndex = Math.floor(step / 16) % melody.length;
      const hornFreq = melody[hornIndex];

      const osc1 = audioCtx.createOscillator();
      const osc2 = audioCtx.createOscillator();
      
      osc1.type = "sawtooth";
      osc2.type = "sawtooth";
      
      osc1.frequency.setValueAtTime(hornFreq, now);
      osc2.frequency.setValueAtTime(hornFreq * 1.006, now); // slightly detuned

      const hornFilter = audioCtx.createBiquadFilter();
      hornFilter.type = "lowpass";
      hornFilter.frequency.setValueAtTime(100, now);
      hornFilter.frequency.exponentialRampToValueAtTime(700, now + 1.2);
      hornFilter.frequency.exponentialRampToValueAtTime(300, now + 2.2);

      const hornGain = audioCtx.createGain();
      hornGain.gain.setValueAtTime(0.001, now);
      hornGain.gain.linearRampToValueAtTime(0.06 * globalBgmVolume, now + 0.8);
      hornGain.gain.exponentialRampToValueAtTime(0.001, now + 2.2);

      osc1.connect(hornFilter);
      osc2.connect(hornFilter);
      hornFilter.connect(hornGain);
      hornGain.connect(audioCtx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 2.3);
      osc2.stop(now + 2.3);
    }

    step++;
  }, 300);
}

function stopRealisticBgmLoop() {
  if (realisticBgmInterval) {
    clearInterval(realisticBgmInterval);
    realisticBgmInterval = null;
  }
}

function playSynthBgm() {
  if (state.realisticEnabled) {
    playRealisticBgmLoop();
    return;
  }
  if (synthBgmInterval) return;
  let step = 0;
  
  let notes: number[];
  let waveType: OscillatorType = "triangle";
  let tempo = 250;
  if (state.modernEnabled) {
    notes = [
      73.42, 73.42, 73.42, 73.42, 87.31, 87.31, 98.00, 98.00,
      73.42, 73.42, 73.42, 73.42, 110.00, 110.00, 98.00, 87.31
    ]; // D2, F2, G2, A2 cyber bass
    waveType = "sawtooth";
    tempo = 220;
  } else {
    notes = [
      110, 110, 130, 110, 165, 165, 147, 130,
      110, 110, 130, 110, 196, 196, 175, 165
    ];
  }
  
  synthBgmInterval = setInterval(() => {
    if (audioCtx.state === "suspended") audioCtx.resume();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    if (state.modernEnabled) {
      osc.type = waveType;
      const lowpass = audioCtx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.setValueAtTime(150, now);
      
      osc.frequency.setValueAtTime(notes[step % notes.length], now);
      gain.gain.setValueAtTime(0.12 * globalBgmVolume, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      
      osc.connect(lowpass);
      lowpass.connect(gain);
    } else {
      osc.type = waveType;
      osc.frequency.setValueAtTime(notes[step % notes.length], now);
      gain.gain.setValueAtTime(0.18 * globalBgmVolume, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      
      osc.connect(gain);
    }
    
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.25);
    step++;
  }, tempo);
}

function stopSynthBgm() {
  if (state.realisticEnabled) {
    stopRealisticBgmLoop();
  }
  if (synthBgmInterval) {
    clearInterval(synthBgmInterval);
    synthBgmInterval = null;
  }
}

export function playBgm() {
  if (isBgmPlaying) return;
  
  if (state.battleCityEnabled || state.modernEnabled || state.realisticEnabled) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    playSynthBgm();
    isBgmPlaying = true;
    return;
  }

  const buffer = buffers.get("bgm");
  if (!buffer) {
    // If called before the fetch completes, retry shortly
    setTimeout(playBgm, 500);
    return;
  }
  
  if (audioCtx.state === "suspended") audioCtx.resume();
  bgmSource = audioCtx.createBufferSource();
  bgmSource.buffer = buffer;
  bgmSource.loop = true;
  
  bgmGainNode = audioCtx.createGain();
  bgmGainNode.gain.value = globalBgmVolume;
  
  bgmSource.connect(bgmGainNode);
  bgmGainNode.connect(audioCtx.destination);
  bgmSource.start();
  isBgmPlaying = true;
}

export function pauseBgm() {
  if (!isBgmPlaying) return;
  if (state.battleCityEnabled || state.modernEnabled || state.realisticEnabled) {
    stopSynthBgm();
  } else if (bgmSource) {
    bgmSource.stop();
    bgmSource.disconnect();
    bgmSource = null;
  }
  isBgmPlaying = false;
}
