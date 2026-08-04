import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwind()],
  // amazon-cognito-identity-js still references `global` in its shipped
  // bundle. Vite 7 auto-polyfilled it; Vite 8 does not (see
  // https://vite.dev/guide/migration.html), so map it to globalThis or
  // the SPA throws `ReferenceError: global is not defined` at boot.
  define: {
    global: "globalThis",
  },
  server: {
    port: 5173,
    proxy: {
      "/tl": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
