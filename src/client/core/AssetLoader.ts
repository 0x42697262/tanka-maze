export type AssetKind = "image" | "audio" | "json";

export interface AssetDefinition {
  readonly id: string;
  readonly kind: AssetKind;
  readonly url: string | URL;
}

export interface LoadedAssets {
  readonly images: ReadonlyMap<string, HTMLImageElement>;
  readonly audio: ReadonlyMap<string, HTMLAudioElement>;
  readonly json: ReadonlyMap<string, unknown>;
}

/**
 * Async asset boundary for the browser client. URLs may be constructed with
 * `new URL("./asset.png", import.meta.url)` so Vite can rewrite them to hashed
 * production paths without the rest of the game knowing about bundler details.
 */
export class AssetLoader {
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly audio = new Map<string, HTMLAudioElement>();
  private readonly json = new Map<string, unknown>();

  async loadAll(definitions: readonly AssetDefinition[]): Promise<LoadedAssets> {
    await Promise.all(definitions.map((definition) => this.load(definition)));
    return this.assets;
  }

  get assets(): LoadedAssets {
    return {
      images: this.images,
      audio: this.audio,
      json: this.json,
    };
  }

  image(id: string): HTMLImageElement {
    const asset = this.images.get(id);
    if (!asset) throw new Error(`Image asset not loaded: ${id}`);
    return asset;
  }

  audioClip(id: string): HTMLAudioElement {
    const asset = this.audio.get(id);
    if (!asset) throw new Error(`Audio asset not loaded: ${id}`);
    return asset;
  }

  jsonData<T>(id: string): T {
    if (!this.json.has(id)) throw new Error(`JSON asset not loaded: ${id}`);
    return this.json.get(id) as T;
  }

  private async load(definition: AssetDefinition): Promise<void> {
    switch (definition.kind) {
      case "image":
        this.images.set(definition.id, await this.loadImage(definition.url));
        break;
      case "audio":
        this.audio.set(definition.id, await this.loadAudio(definition.url));
        break;
      case "json":
        this.json.set(definition.id, await this.loadJson(definition.url));
        break;
    }
  }

  private async loadImage(url: string | URL): Promise<HTMLImageElement> {
    const image = new Image();
    image.decoding = "async";
    image.src = String(url);
    await image.decode();
    return image;
  }

  private async loadAudio(url: string | URL): Promise<HTMLAudioElement> {
    const clip = new Audio(String(url));
    clip.preload = "auto";
    await new Promise<void>((resolve, reject) => {
      clip.addEventListener("canplaythrough", () => resolve(), { once: true });
      clip.addEventListener("error", () => reject(new Error(`Audio asset failed: ${url}`)), { once: true });
      clip.load();
    });
    return clip;
  }

  private async loadJson(url: string | URL): Promise<unknown> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`JSON asset failed: ${url}`);
    return response.json();
  }
}
