/**
 * Production static server with aggressive no-cache headers.
 * Quest Browser and other WebViews often pin index.html otherwise.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
  'Surrogate-Control': 'no-store',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath.split('?')[0].split('#')[0]);
  const cleaned = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(root, cleaned);
  if (!full.startsWith(root)) return null;
  return full;
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...NO_CACHE, ...headers });
  res.end(body);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  send(res, 200, { 'Content-Type': type, 'Content-Length': data.length }, data);
}

const server = http.createServer((req, res) => {
  // CORS not required for same-origin app; keep simple
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { 'Content-Type': 'text/plain' }, 'Method Not Allowed');
    return;
  }

  let urlPath = req.url || '/';
  try {
    urlPath = new URL(urlPath, 'http://localhost').pathname;
  } catch {
    urlPath = '/';
  }
  if (urlPath === '/') urlPath = '/index.html';

  let filePath = safeJoin(DIST, urlPath);

  // SPA fallback → index.html
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    send(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
    return;
  }

  try {
    if (req.method === 'HEAD') {
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const stat = fs.statSync(filePath);
      send(res, 200, { 'Content-Type': type, 'Content-Length': stat.size }, '');
      return;
    }
    sendFile(res, filePath);
  } catch (err) {
    console.error(err);
    send(res, 500, { 'Content-Type': 'text/plain' }, 'Server Error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[glider-sim] serving ${DIST} on http://${HOST}:${PORT} (no-cache)`);
});
