import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from '../src/process.js';
import { parseRecognition } from '../src/engine.js';
import type { Transcript } from '../src/types.js';

// Run after setup. Uses the built entrypoint and real model, never a stub worker.
const root = await mkdtemp(join(tmpdir(), 'pianissimo-inference-'));
const signal = AbortSignal.timeout(10 * 60 * 1000);
const cli = (args: string[], offline = false) => run(process.execPath, [resolve('bin/pianissimo.js'), ...args], {
  signal, env: { ...process.env, ...(offline ? { HF_HUB_OFFLINE: '1' } : {}) },
});
try {
  const doctor = JSON.parse(await cli(['doctor', '--json']));
  assert.ok(doctor.checks.every((check: { ok: boolean }) => check.ok));
  const source = resolve('test/fixtures/swedish.wav');
  const args = [source, '--output', root, '--format', 'json,srt', '--json'];
  const events = (await cli([...args, '--force'], true)).split('\n').map(line => JSON.parse(line));
  const result = events.find(event => event.type === 'transcript');
  assert.ok(result, 'Expected a real transcript');
  assert.equal(result.cached, false);
  const transcript = result.transcript as Transcript;
  parseRecognition(transcript);
  assert.ok(transcript.words.length >= 5, `Expected Swedish speech, got: ${transcript.text}`);
  assert.match(transcript.text.toLowerCase(), /hej|svensk|solen|promenad/);
  assert.ok(transcript.runtime?.device);
  assert.equal(events.at(-1).completed, 1);
  assert.equal(events.at(-1).failed, 0);
  const subtitle = (await readdir(root)).find(name => name.endsWith('.srt'));
  assert.ok(subtitle);
  assert.match(await readFile(join(root, subtitle), 'utf8'), /-->/);
  const cached = (await cli(args, true)).split('\n').map(line => JSON.parse(line));
  assert.equal(cached.find(event => event.type === 'transcript')?.cached, true);
  console.log(JSON.stringify({ device: transcript.runtime.device, text: transcript.text, words: transcript.words.length, offline: true, cacheReused: true }));
} finally { await rm(root, { recursive: true, force: true }); }
