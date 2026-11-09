import { readFile, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const assets = {};
for (const [path, type] of [['index.html', 'text/html'], ['style.css', 'text/css'], ['sketch.js', 'text/javascript'], ['bot.txt', 'text/plain']]) assets['/' + path] = { body: await read('public/' + path), type };
assets['/'] = assets['/index.html'];
const api = (await read('server/api.mjs')).replace('export async function handleApi', 'async function handleApi');
const worker = `${api}\nconst assets = ${JSON.stringify(assets)};
export default { async fetch(request, env) {
 const url = new URL(request.url);
 if (url.pathname.startsWith('/api/')) return handleApi(request, env, assets['/bot.txt'].body);
 if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', {status:405});
 const asset = assets[url.pathname];
 if (asset) return new Response(request.method === 'HEAD' ? null : asset.body, {headers:{'Content-Type':asset.type + '; charset=utf-8','X-Content-Type-Options':'nosniff'}});
 // Large binary assets stream from this project's public GitHub repository.
 if (['/assets/fulano.glb', '/image.png'].includes(url.pathname)) {
  const upstream = await fetch('https://raw.githubusercontent.com/Genesisreyes21/fulana-ai/main/public' + url.pathname, {method:request.method});
  if (!upstream.ok) return new Response('Asset unavailable', {status:502});
  return new Response(upstream.body, {headers:{'Content-Type':url.pathname.endsWith('.glb')?'model/gltf-binary':'image/png','Cache-Control':'public, max-age=3600'}});
 }
 return new Response('Not found', {status:404});
}};
`;
await rm(new URL('dist/', root), { recursive: true, force: true });
await mkdir(new URL('dist/server/', root), { recursive: true });
await mkdir(new URL('dist/.openai/', root), { recursive: true });
await writeFile(new URL('dist/server/index.js', root), worker);
await copyFile(new URL('.openai/hosting.json', root), new URL('dist/.openai/hosting.json', root));
console.log('Built Worker with public assets. No environment values included.');
