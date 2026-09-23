import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { run } from '../src/process.js';
import { discoverSources } from '../src/sources.js';
import { prepareAudio } from '../src/media.js';
process.env.PIANISSIMO_HOME ??= fileURLToPath(new URL('../.pianissimo', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'pianissimo-generic-real-'));
const signal = AbortSignal.timeout(45000);
let page = '', denied = 0;
const clips = new Map<string, Buffer>();
const server = createServer((req, res) => {
  if (req.url === '/page') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><head><title>Generic fixture</title></head><body><audio controls src="/a/audio.wav"></audio><audio controls src="/b/audio.wav"></audio></body></html>');
  } else if (clips.has(req.url ?? '')) {
    if (req.headers.referer !== page) { denied++; res.writeHead(403); res.end('Missing Referer'); return; }
    const bytes = clips.get(req.url!)!;
    res.setHeader('Content-Type', 'audio/wav'); res.setHeader('Content-Length', bytes.length);
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } else { res.writeHead(404); res.end(); }
});
try {
  for (const [id, duration] of [['a', '0.5'], ['b', '0.9']]) {
    const path = join(root, `${id}.wav`);
    await run('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i',`sine=frequency=440:duration=${duration}`,path], { signal });
    clips.set(`/${id}/audio.wav`, await readFile(path));
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  page = `http://127.0.0.1:${(server.address() as {port: number}).port}/page`;
  const sources = [];
  for await (const source of discoverSources(page, { signal, sourceType: 'web' })) sources.push(source);
  assert.equal(sources.length, 2); assert.equal(new Set(sources.map(source => source.id)).size, 2);
  const durations: number[] = [];
  for (const [i, source] of sources.entries()) {
    assert.equal(source.referer, page);
    const audio = await prepareAudio(source, join(root, `prepared-${i}`), signal);
    durations.push(audio.duration);
  }
  assert.ok(Math.abs(durations[0]! - 0.5) < 0.01); assert.ok(Math.abs(durations[1]! - 0.9) < 0.01);
  assert.equal(denied, 0);
  console.log(JSON.stringify({ sources: sources.length, distinctIds: new Set(sources.map(source => source.id)).size, durations, refererRequired: true, deniedRequests: denied }));
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
