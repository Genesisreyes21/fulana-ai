import { mkdir, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const output = new URL('dist/pages/', root);
await rm(output, { recursive: true, force: true });
await mkdir(new URL('assets/', output), { recursive: true });
// Explicit public-file list keeps local configuration and server code out of Pages.
for (const path of ['index.html', 'style.css', 'sketch.js', 'bot.txt', 'image.png', 'assets/fulano.glb']) {
  await copyFile(new URL('public/' + path, root), new URL(path, output));
}
const index = new URL('index.html', output);
let html = await readFile(index, 'utf8');
const marker = '<meta name="fulana-hosting" content="server" />';
if (!html.includes(marker)) throw new Error('Hosting configuration marker is missing');
html = html.replace(marker, '<meta name="fulana-hosting" content="github-pages" />');
html = html.replace('Voice may use your browser’s speech service or ElevenLabs.', 'Voice uses your browser’s speech service.');
await writeFile(index, html);
await writeFile(new URL('.nojekyll', output), '');
console.log('GitHub Pages build ready in dist/pages, with browser voice and no private configuration.');
