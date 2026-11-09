import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
const sketch = await readFile(new URL('../public/sketch.js', import.meta.url), 'utf8');
const start = sketch.indexOf('async function callReplicateProxy(');
const end = sketch.indexOf('// where the API call happens', start);
function client(staticMode, fetch) {
  const context = vm.createContext({ IS_GITHUB_PAGES: staticMode, fetch, AbortSignal });
  vm.runInContext(sketch.slice(start, end), context);
  return context.callReplicateProxy;
}
test('Pages sends history and prompt to the public proxy without credentials', async () => {
  const messages = [{role:'system',content:'Fulana prompt'}, {role:'user',content:'Hello'}];
  const call = client(true, async (url, init) => {
    assert.equal(url, 'https://itp-ima-replicate-proxy.web.app/api/create_n_get');
    assert.deepEqual(JSON.parse(init.body).input.messages, messages);
    assert.equal(JSON.parse(init.body).model, 'openai/gpt-5-mini');
    assert.deepEqual(Object.keys(init.headers), ['Content-Type']);
    return Response.json({ output:['Hello', ' founder.'] });
  });
  assert.equal((await call(messages)).text, 'Hello founder.');
});
test('server mode keeps the private backend route', async () => {
  const call = client(false, async (url, init) => {
    assert.equal(url, '/api/chat');
    assert.deepEqual(JSON.parse(init.body), {messages:[{role:'user',content:'Hello'}]});
    return Response.json({ text:'Hello.' });
  });
  assert.equal((await call([{role:'user',content:'Hello'}])).text, 'Hello.');
});
test('provider failures and empty output are surfaced', async () => {
  await assert.rejects(client(true, async () => new Response('',{status:429}))([]), /HTTP 429/);
  await assert.rejects(client(true, async () => Response.json({ output:[] }))([]), /no reply/);
  await assert.rejects(client(true, async () => Response.json({ error:'failed',output:'partial' }))([]), /no reply/);
});
test('Pages build publishes only public files and keeps repository-relative asset links', async () => {
  execFileSync(process.execPath, ['scripts/build-pages.mjs'], {cwd:new URL('../',import.meta.url)});
  const root = new URL('../dist/pages/', import.meta.url);
  const names = (await readdir(root)).sort();
  assert.deepEqual(names, ['.nojekyll','assets','bot.txt','image.png','index.html','sketch.js','style.css']);
  const html = await readFile(new URL('index.html',root),'utf8');
  assert.ok(html.includes('content="github-pages"'));
  assert.ok(html.includes('src="./assets/fulano.glb"'));
  assert.ok(!html.includes('ElevenLabs'));
  assert.equal((await stat(new URL('assets/fulano.glb',root))).size,41431116);
});
