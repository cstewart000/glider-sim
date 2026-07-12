import { defineConfig } from 'vite';

/**
 * Host on LAN for Quest / phones.
 * WebXR on Quest requires a secure context:
 *  - adb reverse tcp:5173 tcp:5173  → open http://localhost:5173 on headset, or
 *  - use HTTPS (set HTTPS=1 if you add certs / @vitejs/plugin-basic-ssl)
 */
export default defineConfig({
  server: {
    host: true,
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 4173,
  },
});
