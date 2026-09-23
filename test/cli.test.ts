import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_SETTINGS, paths } from '../src/config.js';
import { TranscriptCache } from '../src/cache.js';
import { localSources } from '../src/sources.js';
import { cacheKey } from '../src/util.js';
import { render } from '../src/export.js';
import type { Format, Transcript } from '../src/types.js';

function cli(args: string[], home: string, cwd?: string) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('src/cli.ts'), ...args], {
    encoding: 'utf8', cwd, env: { ...process.env, PIANISSIMO_HOME: home, PIANISSIMO_PYTHON: join(home, 'missing-python') }, timeout: 10000,
  });
}
test('CLI help, validation, and JSON dry-run work without model dependencies or state writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pianissimo-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'state');
  const help = cli(['--help'], home);
  assert.equal(help.status, 0); assert.match(help.stdout, /youtube/);
  const invalid = cli(['transcribe', 'missing.wav', '--chunk-seconds', 'NaN'], home);
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /integer/);
  const badRevision = cli(['transcribe', 'missing.wav', '--revision', 'main'], home);
  assert.notEqual(badRevision.status, 0); assert.match(badRevision.stderr, /commit SHA/);
  const file = join(root, 'example.mp3'); await writeFile(file, 'Dry runs inspect inputs without decoding audio.');
  const plan = cli([file, '--dry-run', '--json'], home);
  assert.equal(plan.status, 0);
  const records = plan.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records[0].type, 'source');
  const json = records.at(-1); assert.equal(json.type, 'plan'); assert.equal(json.count, 1);
  const apple = cli([file, '--dry-run', '--device', 'mps', '--json'], home);
  assert.equal(apple.status, 0); assert.equal(JSON.parse(apple.stdout.trim().split('\n').at(-1)!).count, 1);
  const unknown = cli([file, '--dry-run', '--device', 'metal'], home);
  assert.notEqual(unknown.status, 0); assert.match(unknown.stderr, /Allowed choices/);
  for (const alias of ['transcribe', 'youtube']) {
    for (const args of [[alias, file, '--dry-run', '--json'], ['--dry-run', '--json', alias, file]]) {
      const aliased = cli(args, home);
      assert.equal(aliased.status, 0, aliased.stderr);
      assert.equal(JSON.parse(aliased.stdout.trim().split('\n').at(-1)!).type, 'plan');
    }
  }
  assert.deepEqual(await readdir(root), ['example.mp3']);
  assert.doesNotMatch(help.stdout, /jobs|models|transcribe \[|youtube \[/);
  const advanced = cli(['--help-all'], home);
  assert.equal(advanced.status, 0); assert.match(advanced.stdout, /--chunk-seconds/);
  await writeFile(join(root, '--help-all'), 'A literal filename, not a flag.');
  const literal = cli(['--dry-run', '--json', '--', '--help-all'], home, root);
  assert.equal(literal.status, 0, literal.stderr);
  assert.equal(JSON.parse(literal.stdout.trim().split('\n').at(-1)!).type, 'plan');
});


test('CLI stdout follows export format, streams JSON collections and preserves explicit JSON events', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pianissimo-cli-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), inputs = join(root, 'inputs');
  await mkdir(inputs);
  await writeFile(join(inputs, 'first.wav'), 'First cached input');
  await writeFile(join(inputs, 'second.wav'), 'Second cached input');
  const sources = await localSources(inputs, false, new AbortController().signal);
  const cache = new TranscriptCache(paths(home).transcripts);
  const transcripts: Transcript[] = sources.map(source => ({
    schemaVersion: 1, source, settings: DEFAULT_SETTINGS,
    model: { id: DEFAULT_SETTINGS.model, revision: DEFAULT_SETTINGS.revision, license: 'CC-BY-4.0' },
    duration: 2, createdAt: '2026-09-23T12:00:00.000Z', processingSeconds: 1,
    text: 'Hej Sverige.', words: [{ text: 'Hej', start: 0.1, end: 0.4 }, { text: 'Sverige.', start: 0.5, end: 1.2 }],
  }));
  for (const transcript of transcripts) await cache.save(cacheKey(transcript.source, DEFAULT_SETTINGS), transcript);
  const first = transcripts[0]!;
  const workingDirectory = join(root, 'cwd'); await mkdir(workingDirectory);
  const plain = cli([first.source.location], home, workingDirectory);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, render(first, 'txt'));
  assert.doesNotMatch(plain.stderr, /0 files|undefined|transcripts/);
  for (const format of ['txt', 'md', 'json', 'srt', 'vtt'] as Format[]) {
    const stdoutOnly = cli([first.source.location, '--format', format], home, workingDirectory);
    assert.equal(stdoutOnly.status, 0, stdoutOnly.stderr);
    if (format === 'json') assert.deepEqual(JSON.parse(stdoutOnly.stdout), first);
    else assert.equal(stdoutOnly.stdout, render(first, format));
    const output = join(root, format);
    const result = cli([first.source.location, '--format', format, '--output', output, '--quiet'], home);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    if (format === 'json') assert.deepEqual(JSON.parse(result.stdout), first);
    else assert.equal(result.stdout, render(first, format));
    const exported = (await readdir(output)).find(name => name.endsWith(`.${format}`))!;
    assert.equal(await readFile(join(output, exported), 'utf8'), render(first, format));
  }
  for (const alias of ['transcribe', 'youtube']) {
    for (const args of [
      [alias, first.source.location, '--format', 'srt', '--output', join(root, alias)],
      ['--format', 'srt', '--output', join(root, alias), alias, first.source.location],
      ['--format', 'json', alias, first.source.location, '--format', 'srt', '--output', join(root, alias)],
    ]) {
      const result = cli(args, home);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, render(first, 'srt'));
      assert.ok((await readdir(join(root, alias))).some(name => name.endsWith('.srt')));
    }
  }
  const multiple = cli([first.source.location, '--format', 'srt,txt', '--output', join(root, 'multiple')], home);
  assert.equal(multiple.status, 0, multiple.stderr);
  assert.equal(multiple.stdout, render(first, 'srt'));
  assert.deepEqual((await readdir(join(root, 'multiple'))).map(name => name.split('.').at(-1)).sort(), ['json', 'srt', 'txt']);
  const collection = cli([inputs, '--format', 'json'], home, workingDirectory);
  assert.equal(collection.status, 0, collection.stderr);
  assert.deepEqual(collection.stdout.trim().split('\n').map(line => JSON.parse(line)), transcripts);
  const stdoutEvents = cli([inputs, '--json'], home, workingDirectory);
  assert.equal(stdoutEvents.status, 0, stdoutEvents.stderr);
  const stdoutRecords = stdoutEvents.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(stdoutRecords.at(-1).completed, 2);
  for (const record of stdoutRecords.slice(0, -1)) assert.deepEqual(record.files, []);
  assert.deepEqual(await readdir(workingDirectory), []);
  const events = cli([first.source.location, '--format', 'srt', '--json', '--output', join(root, 'events')], home);
  assert.equal(events.status, 0, events.stderr);
  const records = events.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.type), ['transcript', 'summary']);
  assert.equal(records[0].cached, true); assert.equal(records[1].cached, 1);
  assert.ok((await readdir(join(root, 'events'))).some(name => name.endsWith('.srt')));
  // Cached exports must work without installing, importing or starting a model.
  assert.deepEqual((await readdir(home)).sort(), ['cache']);
});
