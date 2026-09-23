import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/config.js';
import { cues, render, timestamp, exportTranscript } from '../src/export.js';
import { cacheKey, cleanTerminal, safeName } from '../src/util.js';
import { localSources } from '../src/sources.js';
import { mediaUrl } from '../src/feeds.js';
import { parseRecognition } from '../src/engine.js';
import { offsetWords } from '../src/pipeline.js';
import { acquireLock } from '../src/lock.js';
import type { Transcript } from '../src/types.js';

const transcript: Transcript = { schemaVersion: 1, source: { id: 'youtube:abc', kind: 'url', title: '../../Hej: Sverige', location: 'https://youtube.com/watch?v=abc', fingerprint: 'abc' },
  model: { id: DEFAULT_SETTINGS.model, revision: DEFAULT_SETTINGS.revision, license: 'CC-BY-4.0' },
  settings: DEFAULT_SETTINGS, duration: 4, processingSeconds: 1, createdAt: '2026-09-23T12:00:00.000Z',
  text: 'Hej Sverige. Tack!', words: [ { start: 0, end: 0.4, text: 'Hej' }, { start: 0.5, end: 1, text: 'Sverige.' }, { start: 3, end: 4, text: 'Tack!' } ] };

test('subtitle exports preserve timestamps, sentence breaks, and Unicode', () => {
  assert.equal(timestamp(3599.9996, ','), '01:00:00,000');
  assert.equal(timestamp(366100.05), '101:41:40.050');
  assert.deepEqual(cues(transcript.words), [ { start: 0, end: 1, text: 'Hej Sverige.' }, { start: 3, end: 4, text: 'Tack!' } ]);
  assert.match(render(transcript, 'srt'), /1\n00:00:00,000 --> 00:00:01,000\nHej Sverige\./);
  assert.match(render(transcript, 'vtt'), /^WEBVTT\n\n00:00:00.000/);
  assert.equal(render({ ...transcript, text: '', words: [] }, 'vtt'), 'WEBVTT\n\n');
  const words = Array.from({ length: 40 }, (_, i) => ({ start: i * 0.25, end: (i + 1) * 0.25, text: 'inspelningar' }));
  for (const cue of cues(words)) { assert.ok(cue.text.split('\n').length <= 2); assert.ok(cue.end - cue.start <= 6); }
});

test('canonical JSON is always exported and filenames stay in the output directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pianissimo-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = await exportTranscript(transcript, dir, ['txt', 'srt'], 'a'.repeat(64));
  assert.equal(files.length, 3);
  for (const file of files) assert.equal(dirname(file), dir);
  assert.equal(JSON.parse(await readFile(files[0]!, 'utf8')).model.revision, DEFAULT_SETTINGS.revision);
  assert.ok(!safeName('../bad\\name:*').includes('/'));
});

test('cache separates revisions, input content, and inference settings', () => {
  const key = cacheKey(transcript.source, DEFAULT_SETTINGS);
  assert.notEqual(key, cacheKey(transcript.source, { ...DEFAULT_SETTINGS, revision: 'b'.repeat(40) }));
  assert.notEqual(key, cacheKey(transcript.source, { ...DEFAULT_SETTINGS, chunkSeconds: 60 }));
  assert.notEqual(key, cacheKey({ ...transcript.source, fingerprint: 'changed' }, DEFAULT_SETTINGS));
});

test('overlap ownership keeps each boundary word once with global timestamps', () => {
  const left = offsetWords([{ text: 'ett', start: 119, end: 120 }, { text: 'två', start: 120, end: 121 }], 0, 0, 120);
  const right = offsetWords([{ text: 'ett', start: 0, end: 1 }, { text: 'två', start: 1, end: 2 }], 119, 120, 240);
  assert.deepEqual([...left, ...right], [{ text: 'ett', start: 119, end: 120 }, { text: 'två', start: 120, end: 121 }]);
  assert.throws(() => parseRecognition({ text: 'hi', words: [] }), /no word timestamps/);
  assert.throws(() => parseRecognition({ text: 'hi', words: [{ text: 'hi', start: NaN, end: 2 }] }), /invalid word timestamps/);
});

test('local folders ignore symlink loops, hash content, and respect recursion', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pianissimo-sources-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'clip.wav'), 'first'); await writeFile(join(dir, 'notes.txt'), 'ignore');
  await writeFile(join(dir, 'sub', 'clip.MP3'), 'second');
  await symlink(dir, join(dir, 'sub', 'loop'));
  const signal = new AbortController().signal;
  const shallow = await localSources(dir, false, signal);
  assert.equal(shallow.length, 1);
  assert.equal((await localSources(dir, true, signal)).length, 2);
  await writeFile(join(dir, 'clip.wav'), 'other');
  assert.notEqual((await localSources(dir, false, signal))[0]!.fingerprint, shallow[0]!.fingerprint);
});

test('media URLs reject unexpected protocols and credentials', () => {
  assert.equal(mediaUrl('http://youtu.be/abc'), 'http://youtu.be/abc');
  for (const value of ['file:///tmp/a', 'https://user:pass@youtube.com/a', '--exec=evil']) assert.throws(() => mediaUrl(value));
  assert.equal(cleanTerminal('\x1b[31mhello\x1b[0m\x1b]0;title\x07\nworld'), 'hello world');
});

test('run lock excludes concurrent runners and releases cleanly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pianissimo-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const unlock = await acquireLock(dir);
  await assert.rejects(acquireLock(dir), /Another Pianissimo/);
  await unlock();
  await (await acquireLock(dir))();
});

test('Unicode export names fit byte-limited filesystems and retain whole code points', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pianissimo-unicode-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const title of ['語'.repeat(90), '🎙'.repeat(90), 'å'.repeat(90)]) {
    const name = safeName(title);
    assert.ok(Buffer.byteLength(name) <= 160);
    assert.equal(Buffer.from(name).toString('utf8'), name);
    const files = await exportTranscript({ ...transcript, source: { ...transcript.source, title } }, dir, ['txt'], 'b'.repeat(64));
    for (const file of files) {
      assert.ok(Buffer.byteLength(file.slice(dir.length + 1)) <= 255);
      assert.ok((await readFile(file, 'utf8')).length > 0);
    }
  }
});
