import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwind()],
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
