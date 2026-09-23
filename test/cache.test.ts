import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TranscriptCache } from '../src/cache.js';
import { cacheKey } from '../src/util.js';
import { DEFAULT_SETTINGS } from '../src/config.js';
import type { Transcript } from '../src/types.js';

test('invalid cache entries are misses; canonical exports survive cache deletion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pianissimo-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = new TranscriptCache(join(root, 'cache'));
  const transcript: Transcript = { schemaVersion: 1, source: { id: 'test', kind: 'url', title: 'Test', location: 'https://example.org', fingerprint: 'test' },
    settings: DEFAULT_SETTINGS, model: { id: DEFAULT_SETTINGS.model, revision: DEFAULT_SETTINGS.revision, license: 'CC-BY-4.0' }, duration: 2,
    createdAt: new Date().toISOString(), processingSeconds: 1, text: 'Hej', words: [{ text: 'Hej', start: 0, end: 1 }] };
  const key = cacheKey(transcript.source, DEFAULT_SETTINGS);
  const directory = join(root, 'cache', key.slice(0, 2)), path = join(directory, `${key}.json`);
  await mkdir(directory, { recursive: true }); await writeFile(path, '{broken');
  assert.equal(await cache.get(key), undefined);
  await writeFile(path, JSON.stringify({ ...transcript, words: [{ text: 'Hej', start: -1, end: 1 }] }));
  assert.equal(await cache.get(key), undefined);
  await writeFile(path, JSON.stringify({ ...transcript, settings: { ...DEFAULT_SETTINGS, revision: 'a'.repeat(40) } }));
  assert.equal(await cache.get(key), undefined);
  const exported = join(root, 'export.json'); await writeFile(exported, JSON.stringify(transcript));
  await rm(join(root, 'cache'), { recursive: true });
  assert.deepEqual(await cache.get(key, exported), transcript);
  await cache.save(key, transcript); assert.deepEqual(await cache.get(key), transcript);
  await assert.rejects(cache.get('../escape'), /Invalid transcript cache key/);
});
