/**
 * Browser audio gate that respects autoplay policies. Audio stays muted until a
 * user gesture unlocks playback; callers can request sounds safely before then.
 */
export class AudioManager {
  private unlocked = false;

  constructor(private readonly clips: ReadonlyMap<string, HTMLAudioElement>) {}

  bindUnlock(target: EventTarget = window): void {
    const unlock = () => {
      this.unlocked = true;
      target.removeEventListener("pointerdown", unlock);
      target.removeEventListener("keydown", unlock);
    };
    target.addEventListener("pointerdown", unlock, { once: true });
    target.addEventListener("keydown", unlock, { once: true });
  }

  play(id: string): void {
    if (!this.unlocked) return;
    const clip = this.clips.get(id);
    if (!clip) return;
    const instance = clip.cloneNode(true) as HTMLAudioElement;
    void instance.play().catch(() => {});
  }
}
