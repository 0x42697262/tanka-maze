/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional WebSocket server URL when the client is hosted separately. */
  readonly VITE_WS_URL?: string;
}
