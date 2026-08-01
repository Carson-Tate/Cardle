// Zero-dependency static file server for local development.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8080;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  // Served from the repo root (robots.txt, sitemap.xml). Without these they'd
  // fall through to application/octet-stream and download rather than render,
  // which makes them awkward to eyeball locally.
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/public/index.html';

  const filePath = path.join(ROOT, urlPath);

  // `ROOT + path.sep`, not bare `ROOT`. A plain prefix test passes for a SIBLING
  // directory whose name merely starts with the project's: `/../Cardle-backup/x`
  // resolves to `…\Desktop\Cardle-backup\x`, which "starts with" `…\Desktop\Cardle`
  // and was served. The separator makes it a real containment check.
  //
  // The dotfile rule is the more important half: without it `/.git/config` and
  // `/.env` were served to anyone who asked. This listens on every interface, so
  // "it's only the dev server" means "anyone on the same café or office network
  // while npm run dev is running".
  const insideRoot = filePath.startsWith(ROOT + path.sep);
  const hidden = urlPath.split('/').some((segment) => segment.startsWith('.'));
  if (!insideRoot || hidden) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Loopback only. This serves the entire repo with no auth, so binding every
// interface put the working tree on the local network for the duration of every
// dev session. Nothing needs it reachable from another machine; if you ever do
// (testing on a phone), pass the host explicitly rather than removing this.
server.listen(PORT, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`Cardle dev server running at http://localhost:${PORT}`);
});
