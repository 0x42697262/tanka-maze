import {
  decode,
  encode,
  type ClientMessage,
  type ServerMessage,
} from "../shared/protocol.js";

type Handler = (msg: ServerMessage) => void;
type StatusHandler = (status: "connecting" | "open" | "closed") => void;

function resolveWsUrl(): string {
  // In Vite dev the page is served from :5173 while the game server runs on
  // :8080. In production the static client is served by the game server, so we
  // connect to the same origin.
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  if (import.meta.env.DEV) {
    return `${proto}//${location.hostname}:8080`;
  }
  return `${proto}//${location.host}`;
}

export class Net {
  private ws: WebSocket | null = null;
  private handler: Handler = () => {};
  private statusHandler: StatusHandler = () => {};
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  onMessage(handler: Handler): void {
    this.handler = handler;
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  connect(): void {
    this.statusHandler("connecting");
    const ws = new WebSocket(resolveWsUrl());
    this.ws = ws;

    ws.onopen = () => this.statusHandler("open");
    ws.onmessage = (ev) => {
      try {
        this.handler(decode<ServerMessage>(ev.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      this.statusHandler("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encode(msg));
    }
  }
}
