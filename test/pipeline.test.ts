import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, paths } from '../src/config.js';
import { TranscriptCache } from '../src/cache.js';
import { Reporter } from '../src/reporter.js';
import { runSources } from '../src/pipeline.js';
import { cacheKey } from '../src/util.js';
import type { Engine, RunOptions, Source } from '../src/types.js';
import type { Completed } from '../src/pipeline.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'pianissimo-run-'));
  const home = { ...paths(root), work: join(root, 'work') };
  t.after(() => rm(root, { recursive: true, force: true }));
  const source: Source = { id: 'youtube:testvideo01', kind: 'url', title: 'Svenska röster', location: 'https://www.youtube.com/watch?v=testvideo01', fingerprint: 'source1' };
  const options = { output: join(root, 'out'), formats: ['txt', 'srt', 'vtt'], settings: { ...DEFAULT_SETTINGS, chunkSeconds: 15 }, downloads: 2, keepAudio: false, force: false } satisfies RunOptions;
  const prepare = async (_source: Source, directory: string) => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'audio.wav'), 'fixture');
    return { directory, path: join(directory, 'audio.wav'), duration: 31 };
  };
  const slice = async () => {};
  return { root, home, source, options, prepare, slice, reporter: new Reporter(true), signal: new AbortController().signal };
}
const result = { text: 'Hej Sverige.', words: [{ start: 1.1, end: 1.5, text: 'Hej' }, { start: 1.5, end: 1.9, text: 'Sverige.' }] };
const engine = (transcribe: Engine['transcribe'] = async () => result): Engine => ({ close: async () => {}, transcribe });

test('without output, inference is cached and can be exported later without preparing audio', async t => {
  const f = await fixture(t);
  const completed: Completed[] = [];
  const { output: _output, ...options } = f.options;
  const first = await runSources([f.source], options, { ...f,
    dependencies: { engine: engine(), prepare: f.prepare, slice: f.slice },
    onResult: value => { completed.push(value); },
  });
  assert.equal(first.completed, 1); assert.equal(first.cached, 0);
  assert.deepEqual(completed[0]!.files, []);
  assert.ok(completed[0]!.transcript.text.includes('Hej Sverige.'));
  assert.ok(await new TranscriptCache(f.home.transcripts).get(cacheKey(f.source, options.settings)));
  await assert.rejects(() => readdir(f.options.output), { code: 'ENOENT' });
  const exported = await runSources([f.source], f.options, { ...f,
    dependencies: {
      engine: engine(async () => { throw new Error('Must not infer'); }),
      prepare: async () => { throw new Error('Must not prepare audio'); },
    },
  });
  assert.equal(exported.cached, 1); assert.equal(exported.completed, 1);
  assert.deepEqual((await readdir(f.options.output)).map(file => file.split('.').at(-1)).sort(), ['json', 'srt', 'txt', 'vtt']);
});

test('interruption saves only complete files; reruns start the interrupted file over', async t => {
  const f = await fixture(t); const abort = new AbortController(); let calls = 0;
  await assert.rejects(runSources([f.source], f.options, { ...f, signal: abort.signal,
    dependencies: { prepare: f.prepare, slice: f.slice, engine: engine(async () => {
      if (++calls === 2) { abort.abort(); throw new Error('Interrupted'); } return result;
    }) } }));
  const cache = new TranscriptCache(f.home.transcripts);
  assert.equal(await cache.get(cacheKey(f.source, f.options.settings)), undefined);
  assert.deepEqual(await readdir(f.home.work), []);
  let resumed = 0;
  const done = await runSources([f.source], f.options, { ...f, dependencies: { prepare: f.prepare, slice: f.slice,
    engine: { ...engine(async () => { resumed++; return result; }), runtime: { device: 'mps' } } } });
  assert.equal(done.completed, 1); assert.equal(resumed, 3);
  const files = await readdir(f.options.output); assert.equal(files.length, 4);
  const transcript = JSON.parse(await readFile(join(f.options.output, files.find(file => file.endsWith('.json'))!), 'utf8'));
  assert.equal(transcript.text, 'Hej Sverige. Hej Sverige. Hej Sverige.');
  assert.ok(transcript.words[2].start >= 15); assert.equal(transcript.runtime.device, 'mps');
  const cached = await runSources([f.source], { ...f.options, output: join(f.root, 'new-out'), formats: ['md'] }, { ...f,
    dependencies: { engine: engine(async () => { throw new Error('Must not infer'); }), prepare: async () => { throw new Error('Must not download'); } } });
  assert.equal(cached.cached, 1); assert.equal(cached.completed, 1);
});

test('failed downloads do not stop the remaining sources; rerun reuses successes', async t => {
  const f = await fixture(t); const second = { ...f.source, id: 'second', fingerprint: 'source2', title: 'Second' };
  const first = await runSources([f.source, second], f.options, { ...f, dependencies: { engine: engine(), slice: f.slice,
    prepare: async (source, dir) => { if (source.id === f.source.id) throw new Error('Unavailable'); return f.prepare(source, dir); } } });
  assert.equal(first.status, 'partial'); assert.equal(first.failed, 1); assert.equal(first.completed, 1);
  const retry = await runSources([f.source, second], f.options, { ...f, dependencies: { engine: engine(), slice: f.slice, prepare: f.prepare } });
  assert.equal(retry.completed, 2); assert.equal(retry.cached, 1);
});

test('export failure retains inference cache and retry needs no inference', async t => {
  const f = await fixture(t); await writeFile(f.options.output, 'Not a directory');
  const first = await runSources([f.source], f.options, { ...f, dependencies: { engine: engine(), prepare: f.prepare, slice: f.slice } });
  assert.equal(first.status, 'failed');
  assert.ok(await new TranscriptCache(f.home.transcripts).get(cacheKey(f.source, f.options.settings)));
  await rm(f.options.output);
  const retry = await runSources([f.source], f.options, { ...f, dependencies: { engine: engine(async () => { throw new Error('Must use cache'); }) } });
  assert.equal(retry.completed, 1); assert.equal(retry.cached, 1);
});

test('force bypasses saved transcripts and preparation remains bounded', async t => {
  const f = await fixture(t); let prepared = 0, calls = 0;
  const sources = Array.from({ length: 12 }, (_, i) => ({ ...f.source, id: `id${i}`, fingerprint: `fp${i}` }));
  await runSources(sources, f.options, { ...f, dependencies: { slice: f.slice,
    prepare: async (source, directory) => { prepared++; return f.prepare(source, directory); },
    engine: engine(async () => { if (++calls === 1) assert.ok(prepared <= 3); return result; }) } });
  calls = 0;
  const forced = await runSources([sources[0]!], { ...f.options, force: true }, { ...f, dependencies: { prepare: f.prepare, slice: f.slice, engine: engine(async () => { calls++; return result; }) } });
  assert.equal(forced.cached, 0); assert.equal(calls, 3);
});

test('output failure cancels discovery and prepared work before returning', async t => {
  const f = await fixture(t); let stopped = false;
  const discover = async function* (signal: AbortSignal) {
    try { for (let i = 0; i < 100; i++) { signal.throwIfAborted(); yield { ...f.source, id: `id${i}`, fingerprint: `fp${i}` }; } }
    finally { stopped = true; }
  };
  await assert.rejects(runSources(discover, f.options, { ...f, dependencies: { prepare: f.prepare, slice: f.slice, engine: engine() },
    onResult: () => { throw new Error('Broken output'); } }), /Broken output/);
  assert.equal(stopped, true);
  assert.deepEqual(await readdir(f.home.work), []);
});

test('trailing sample padding stays in the final chunk instead of starting a tiny extra inference', async t => {
  const f = await fixture(t); let calls = 0;
  const done = await runSources([f.source], f.options, { ...f, dependencies: { slice: f.slice,
    prepare: async (source, directory) => ({ ...await f.prepare(source, directory), duration: 30.001 }),
    engine: engine(async () => { calls++; return result; }) } });
  assert.equal(done.completed, 1); assert.equal(calls, 2);
});

test('changing a local file during preparation never populates its old content cache', async t => {
  const f = await fixture(t); const location = join(f.root, 'input.wav'); await writeFile(location, 'changed');
  const source: Source = { ...f.source, kind: 'file', location, fingerprint: 'old-content-hash' };
  let inferred = false;
  const done = await runSources([source], f.options, { ...f, dependencies: { prepare: f.prepare, slice: f.slice,
    engine: engine(async () => { inferred = true; return result; }) } });
  assert.equal(done.failed, 1); assert.equal(inferred, false);
  assert.equal(await new TranscriptCache(f.home.transcripts).get(cacheKey(source, f.options.settings)), undefined);
});

test('a permanent worker failure stops discovery and does not attempt every source', async t => {
  const { EngineError } = await import('../src/engine.js');
  const f = await fixture(t); let discovered = 0, prepared = 0, calls = 0, stopped = false;
  const sources = async function* (signal: AbortSignal) {
    try { for (let i = 0; i < 100; i++) { signal.throwIfAborted(); discovered++; yield { ...f.source, id: `id${i}`, fingerprint: `fp${i}` }; } }
    finally { stopped = true; }
  };
  await assert.rejects(runSources(sources, f.options, { ...f, dependencies: {
    prepare: async (source, directory) => { prepared++; return f.prepare(source, directory); }, slice: f.slice,
    engine: engine(async () => { calls++; throw new EngineError('Missing NeMo'); }),
  } }), /Missing NeMo/);
  assert.equal(calls, 1); assert.ok(prepared <= 3); assert.ok(discovered <= 5); assert.equal(stopped, true);
  assert.deepEqual(await readdir(f.home.work), []);
});
