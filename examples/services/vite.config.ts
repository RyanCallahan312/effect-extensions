import { effectServerFns } from "@rc312/tss-effect-serverfn/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [effectServerFns(), tanstackStart(), react()],
  preview: { port: 3001 },
  server: { port: 3001 },
});
