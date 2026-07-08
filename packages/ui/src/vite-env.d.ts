/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PARLIAMENT_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
