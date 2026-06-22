/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_KEY?: string;
  /** Set to "1" to run the client as a permanently-offline demo (no server sync). */
  readonly VITE_DEMO_OFFLINE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
