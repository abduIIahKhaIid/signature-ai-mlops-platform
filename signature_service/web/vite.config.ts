import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` talks to a running API through this proxy, e.g. the EC2 server:
//   API_TARGET=http://13.236.244.226:8000 npm run dev
const target = process.env.API_TARGET || "http://localhost:8000";
const proxy = Object.fromEntries(
  ["/v1", "/health", "/ready", "/webhooks"].map((p) => [p, { target, changeOrigin: true }]),
);

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
});
