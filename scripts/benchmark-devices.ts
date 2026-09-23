// Usage: node --import tsx scripts/benchmark-devices.ts <audio-file>
// Runs real inference. On macOS, the process must have access to Metal.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_SETTINGS, paths } from '../src/config.js';
import { NemoEngine } from '../src/engine.js';
import { localSources } from '../src/sources.js';
import { prepareAudio } from '../src/media.js';
import type { Recognition } from '../src/types.js';

const input = process.argv[2];
if (!input) throw new Error('Provide an audio file to benchmark.');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
const directory = await mkdtemp(join(tmpdir(), 'pianissimo-benchmark-'));
const home = paths(process.env.PIANISSIMO_HOME ?? '.pianissimo');
let reference: Recognition | undefined;
try {
  const source = (await localSources(input, false, controller.signal))[0]!;
  const audio = await prepareAudio(source, directory, controller.signal);
  for (const device of ['cpu', 'mps'] as const) {
    const engine = new NemoEngine({ ...DEFAULT_SETTINGS, device }, home, text => process.stderr.write(text + '\n'));
    try {
      const coldStart = performance.now();
      await engine.transcribe(audio.path, controller.signal);
      const coldSeconds = (performance.now() - coldStart) / 1000;
      const seconds: number[] = [];
      let result: Recognition | undefined;
      for (let i = 0; i < 2; i++) {
        const start = performance.now();
        result = await engine.transcribe(audio.path, controller.signal);
        seconds.push((performance.now() - start) / 1000);
      }
      const mean = seconds.reduce((a, b) => a + b, 0) / seconds.length;
      process.stdout.write(JSON.stringify({ device, runtime: engine.runtime, audioSeconds: audio.duration,
        coldSeconds, warmSeconds: seconds, realtime: audio.duration / mean,
        textMatchesCpu: reference ? result!.text === reference.text : true,
        words: result!.words.length }) + '\n');
      reference ??= result;
    } finally { await engine.close(); }
  }
} finally { await rm(directory, { recursive: true, force: true }); }
