import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.mjs';
const root = new URL('../public/', import.meta.url);
const prompt = await readFile(new URL('bot.txt', root), 'utf8');
const allowed = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ['/sketch.js', ['sketch.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/bot.txt', ['bot.txt', 'text/plain']], ['/image.png', ['image.png', 'image/png']], ['/assets/fulano.glb', ['assets/fulano.glb', 'model/gltf-binary']]]);
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const init = { method: req.method, headers: req.headers };
      if (!['GET', 'HEAD'].includes(req.method)) { init.body = req; init.duplex = 'half'; }
      const result = await handleApi(new Request(url, init), process.env, prompt);
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer())); return;
    }
    const asset = allowed.get(url.pathname);
    if (!asset || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end('Not found'); return; }
    const bytes = await readFile(new URL(asset[0], root));
    res.writeHead(200, { 'Content-Type': asset[1], 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(500); res.end('Request failed'); }
}).listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`Fulana AI: http://localhost:${process.env.PORT || 3000}`));
