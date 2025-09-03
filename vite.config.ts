import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/power_app/",
  plugins: [react()],
  resolve: {
    // Simple alias that works in CI too
    alias: { "@": "/src" },
  },
});
