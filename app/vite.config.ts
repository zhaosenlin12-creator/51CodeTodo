import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@pometodo/service-extension": resolve(process.env.POMETODO_SERVICE_EXTENSION || "src/extensions/serviceExtension.tsx") } },
  // Bundle only explicitly imported assets; use the system fonts in theme.css.
  publicDir: false,
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1427, strictPort: true },
  build: { target: "es2022" },
});
