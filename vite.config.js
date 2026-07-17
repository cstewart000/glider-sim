import { defineConfig } from 'vite';

/** Unique per build so Quest users can confirm they loaded a new deploy */
const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Host on LAN for Quest / phones.
 * WebXR on Quest requires a secure context:
 *  - adb reverse tcp:5173 tcp:5173  → open http://localhost:5173 on headset, or
 *  - use public HTTPS (Railway).
 *
 * Aggressive Cache-Control on all responses so Quest Browser doesn't pin old JS.
 */
export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    },
  },
  preview: {
    host: true,
    port: 4173,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    },
  },
  build: {
    // Always hash assets so a new deploy never reuses old filenames
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [
    {
      name: 'inject-build-id',
      transformIndexHtml(html) {
        return html
          .replace(
            /<title>.*?<\/title>/,
            `<title>Low Poly Glider · ${BUILD_ID}</title>`
          )
          .replace(
            '</head>',
            `    <meta name="glider-build" content="${BUILD_ID}" />\n  </head>`
          )
          .replace('<body', `<body data-build="${BUILD_ID}"`);
      },
    },
  ],
});

