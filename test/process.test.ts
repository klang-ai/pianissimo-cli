import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { run } from '../src/process.js';
import { prepareAudio, sliceAudio } from '../src/media.js';
import { isRecentYtdlp } from '../src/ytdlp.js';
import { localSources } from '../src/sources.js';

test('child process arguments are literal and output can be streamed as JSONL', async () => {
  const hostile = 'a; echo unsafe $(touch /tmp/never-run) "quotes"';
  assert.equal(await run(process.execPath, ['-e', 'console.log(process.argv[1])', hostile]), hostile);
  const lines: unknown[] = [];
  await run(process.execPath, ['-e', 'console.log(JSON.stringify({a:1}));console.log(JSON.stringify({b:2}))'], { onLine: line => lines.push(JSON.parse(line)) });
  assert.deepEqual(lines, [{ a: 1 }, { b: 2 }]);
});

test('failed, missing, oversized and interrupted child processes terminate with useful errors', async () => {
  await assert.rejects(run('pianissimo-does-not-exist', []), /Cannot start/);
  await assert.rejects(run(process.execPath, ['-e', 'console.error("bad input");process.exit(3)']), /bad input/);
  await assert.rejects(run(process.execPath, ['-e', 'console.log("x".repeat(1000))'], { maxOutput: 10 }), /too much output/);
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 }), /timed out/);
  const controller = new AbortController();
  const child = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(child, /Interrupted/);
});

test('the supported yt-dlp range rejects old system installations', () => {
  assert.equal(isRecentYtdlp('2024.12.03'), false);
  assert.equal(isRecentYtdlp('2026.8.19'), true);
  assert.equal(isRecentYtdlp('2026.08.19'), true);
  assert.equal(isRecentYtdlp('unparseable'), false);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
test('real FFmpeg normalizes stereo input and slices 16 kHz mono audio', { skip: !hasFfmpeg }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pianissimo-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'stereo.wav');
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '2', '-ar', '44100', file]);
  const signal = new AbortController().signal;
  const source = (await localSources(file, false, signal))[0]!;
  const audio = await prepareAudio(source, join(dir, 'normalized'), signal);
  assert.ok(Math.abs(audio.duration - 2) < 0.01);
  const chunk = join(dir, 'chunk.wav');
  await sliceAudio(audio.path, chunk, 0.5, 1, signal);
  const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', chunk]));
  assert.equal(probe.streams[0].sample_rate, '16000'); assert.equal(probe.streams[0].channels, 1);
  assert.ok(Math.abs(Number(probe.streams[0].duration) - 1) < 0.01);
  assert.ok((await readFile(chunk)).length > 32000);
});

test('cancellation stops descendants even if the process leader exits first', { skip: process.platform === 'win32' }, async () => {
  const abort = new AbortController(); let descendant = 0;
  const childCode = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    console.log(child.pid);
    setInterval(()=>{},1000);
  `;
  try {
    await assert.rejects(run(process.execPath, ['-e', childCode], { signal: abort.signal,
      onLine: line => { descendant = Number(line); abort.abort(); } }), /Interrupted/);
    // Let the OS reap the orphan after its group receives SIGKILL.
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(descendant, 0); await new Promise(resolve => setTimeout(resolve, 10)); }
      catch { alive = false; }
    }
    assert.equal(alive, false, 'descendant survived cancellation');
  } finally { try { process.kill(descendant, 'SIGKILL'); } catch {} }
});

test('cancellation escalates against descendants that ignore TERM and hold inherited pipes', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const abort = new AbortController(); let descendant = 0;
  const code = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); console.log(process.pid); setInterval(()=>{},1000)'], { stdio: 'inherit' });
    setInterval(()=>{},1000);
  `;
  const started = Date.now();
  try {
    await assert.rejects(run(process.execPath, ['-e', code], { signal: abort.signal,
      onLine: line => { descendant = Number(line); abort.abort(); } }), /Interrupted/);
    assert.ok(Date.now() - started < 7000, 'pipes prevented shutdown after escalation');
  } finally { try { process.kill(descendant, 'SIGKILL'); } catch {} }
});

test('direct embedded media retains the extractor referer and chosen resource during download', { skip: !hasFfmpeg || process.platform === 'win32' }, async t => {
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'pianissimo-referer-'));
  const fixture = join(root, 'fixture.wav');
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', fixture]);
  const executable = join(root, 'yt-dlp');
  await writeFile(executable, `#!${process.execPath}
const args=process.argv.slice(2);
if(args[args.indexOf('--referer')+1] !== 'https://example.org/page') throw new Error('HTTP 403: missing referer');
if(args.at(-1) !== 'https://cdn.example.org/audio.mp3') throw new Error('Wrong resource');
require('node:fs').copyFileSync(${JSON.stringify(fixture)}, args[args.indexOf('-o')+1].replace('%(ext)s','wav'));
`, { mode: 0o700 });
  const previous = process.env.PIANISSIMO_YTDLP;
  process.env.PIANISSIMO_YTDLP = executable;
  t.after(async () => {
    if (previous === undefined) delete process.env.PIANISSIMO_YTDLP; else process.env.PIANISSIMO_YTDLP = previous;
    await rm(root, { recursive: true, force: true });
  });
  const audio = await prepareAudio({ id: 'generic:test', fingerprint: 'test', kind: 'url', title: 'Test',
    location: 'https://example.org/page', referer: 'https://example.org/page', mediaUrl: 'https://cdn.example.org/audio.mp3' }, join(root, 'prepared'), new AbortController().signal);
  assert.ok(Math.abs(audio.duration - 0.3) < 0.01);
});
