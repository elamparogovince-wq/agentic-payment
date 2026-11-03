import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const safeName = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'styles.css', 'demo.js'].includes(safeName)) {
    response.writeHead(404); response.end('Not found'); return;
  }
  try {
    const body = await readFile(join(root, safeName));
    response.writeHead(200, { 'content-type': types[extname(safeName)], 'cache-control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(500); response.end('Could not load the demo.');
  }
});

const port = Number(process.env.PORT || 4173);
server.listen(port, '127.0.0.1', () => console.log(`AeroPay demo: http://127.0.0.1:${port}`));
