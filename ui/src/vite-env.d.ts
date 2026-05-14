/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AGENT_URL?: string;
  readonly VITE_DEMO_PASSWORD?: string;
  readonly VITE_COGNITO_HOSTED_UI_DOMAIN?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
