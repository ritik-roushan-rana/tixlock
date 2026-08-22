/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin, e.g. https://api.example.com. Empty = same origin. */
  readonly VITE_API_URL?: string;
  /** Socket.io origin. Defaults to VITE_API_URL when unset. */
  readonly VITE_SOCKET_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
