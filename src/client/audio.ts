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

/** Instantly play a sound effect from memory. */
export function playSfx(name: string, volume = 1.0) {
  const buffer = buffers.get(name);
  if (!buffer) return;
  if (audioCtx.state === "suspended") audioCtx.resume();
  
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = volume * globalSfxVolume;
  
  source.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  source.start();
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
  vroomGainNode.gain.value = 0.2 * globalSfxVolume; // Engine sound sits quietly in the background
  
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
  isVroomPlaying = false;
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
