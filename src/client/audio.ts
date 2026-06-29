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
loadAudio("pew", "/pew.mp3");
loadAudio("explosion", "/explosion.mp3");
loadAudio("vroom", "/vroom.ogg");
loadAudio("reloading", "/reloading.mp3");
loadAudio("powerup", "/powerup.mp3");
loadAudio("first_blood", "/first_blood.mp3");
loadAudio("double_kill", "/double_kill.mp3");
loadAudio("triple_kill", "/triple_kill.mp3");
loadAudio("maniac", "/maniac.mp3");
loadAudio("savage", "/savage.mp3");

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
