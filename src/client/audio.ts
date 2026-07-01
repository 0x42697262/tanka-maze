// Dedicated Web Audio API manager for zero-latency sound effects and gapless looping.

export const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
const buffers = new Map<string, AudioBuffer>();

export function loadAudio(name: string, url: string) {
  fetch(url)
    .then((res) => res.arrayBuffer())
    .then((data) => audioCtx.decodeAudioData(data))
    .then((buffer) => buffers.set(name, buffer))
    .catch((e) => console.warn(`Failed to load audio: ${name}`, e));
}

// Preload sound effects into memory
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

let vroomSource: AudioBufferSourceNode | null = null;
export let isVroomPlaying = false;

export function playVroom() {
  if (isVroomPlaying) return;
  const buffer = buffers.get("vroom");
  if (!buffer) return;
  
  if (audioCtx.state === "suspended") audioCtx.resume();
  vroomSource = audioCtx.createBufferSource();
  vroomSource.buffer = buffer;
  vroomSource.loop = true;
  
  vroomGainNode = audioCtx.createGain();
  vroomGainNode.gain.value = 0.12 * globalSfxVolume; // Start with quiet idle engine volume
  vroomSource.playbackRate.value = 0.75; // Low idle purr pitch
  
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
  // timeConstant = 0.1 results in a smooth transition over about ~0.25 seconds
  vroomSource.playbackRate.setTargetAtTime(targetPitch, now, 0.1);
  vroomGainNode.gain.setTargetAtTime(targetGain * globalSfxVolume, now, 0.1);
}

export let globalBgmVolume = 0.5;
let bgmSource: AudioBufferSourceNode | null = null;
let bgmGainNode: GainNode | null = null;
export let isBgmPlaying = false;

export function setBgmVolume(vol: number) {
  globalBgmVolume = vol;
  if (bgmGainNode) {
    bgmGainNode.gain.value = globalBgmVolume;
  }
}

export function playBgm() {
  if (isBgmPlaying) return;
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
  if (!isBgmPlaying || !bgmSource) return;
  bgmSource.stop();
  bgmSource.disconnect();
  bgmSource = null;
  isBgmPlaying = false;
}
