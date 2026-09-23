import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './config.js';
import { TranscriptCache } from './cache.js';
import { acquireLock } from './lock.js';
import { prepareAudio, sliceAudio } from './media.js';
import { EngineError, NemoEngine } from './engine.js';
import { exportStem, exportTranscript } from './export.js';
import { cacheKey, message, duration, hashFile } from './util.js';
import { importModels } from './state.js';
import type { Reporter } from './reporter.js';
import type { Engine, RunOptions, Source, Transcript, Word } from './types.js';

export function offsetWords(words: Word[], offset: number, start: number, end: number): Word[] {
  return words.filter(word => {
    const midpoint = offset + (word.start + word.end) / 2;
    return midpoint >= start && midpoint < end;
  }).map(word => ({ ...word, start: Math.max(start, offset + word.start), end: Math.min(end, offset + word.end) }));
}

// At most `concurrency` prepared inputs wait ahead of the single inference worker.
// Rejections are values until consumed, so a failed download never becomes unhandled.
async function* prefetch<T, R>(inputs: AsyncIterable<T> | Iterable<T>, concurrency: number, prepare: (input: T) => Promise<R>, cancel: () => void) {
  const queue: Promise<{ input: T; value?: R; error?: unknown }>[] = [];
  let wake: (() => void) | undefined, space: (() => void) | undefined;
  let done = false, stopped = false, failure: unknown;
  const producer = (async () => {
    try {
      for await (const input of inputs) {
        if (stopped) break;
        while (queue.length >= concurrency && !stopped) await new Promise<void>(resolve => { space = resolve; });
        if (stopped) break;
        queue.push(prepare(input).then(value => ({ input, value }), error => ({ input, error })));
        wake?.(); wake = undefined;
      }
    } catch (error) { failure = error; }
    finally { done = true; wake?.(); }
  })();
  try {
    while (!done || queue.length) {
      if (!queue.length) { await new Promise<void>(resolve => { wake = resolve; }); continue; }
      const next = queue.shift()!;
      space?.(); space = undefined;
      yield await next;
    }
    if (failure) throw failure;
  } finally {
    stopped = true; if (!done || queue.length) cancel(); space?.();
    await producer;
    await Promise.all(queue);
  }
}
export interface RunSummary { type: 'summary'; status: 'completed' | 'partial' | 'failed'; completed: number; failed: number; cached: number }
export interface Completed { type: 'transcript'; cached: boolean; transcript: Transcript; files: string[] }
interface Context {
  signal: AbortSignal;
  reporter: Reporter;
  home?: ReturnType<typeof paths>;
  onResult?: (result: Completed) => Promise<void> | void;
  onFailure?: (source: Source, error: string) => Promise<void> | void;
  dependencies?: { engine?: Engine; prepare?: typeof prepareAudio; slice?: typeof sliceAudio };
}
export async function runSources(sources: ((signal: AbortSignal) => AsyncIterable<Source>) | Iterable<Source>, options: RunOptions, context: Context): Promise<RunSummary> {
  const home = context.home ?? paths();
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const unlock = await acquireLock(home.root, error => controller.abort(error));
  const reporter = context.reporter;
  const cache = new TranscriptCache(home.transcripts);
  const engine = context.dependencies?.engine ?? new NemoEngine(options.settings, home, text => reporter.status(text));
  const prepare = context.dependencies?.prepare ?? prepareAudio;
  const slice = context.dependencies?.slice ?? sliceAudio;
  const summary: RunSummary = { type: 'summary', status: 'completed', completed: 0, failed: 0, cached: 0 };
  let directory: string | undefined;
  let modelCacheReady = false;
  reporter.start();
  try {
    await mkdir(home.work, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(home.work, 'run-'));
    const prepared = prefetch(typeof sources === 'function' ? sources(signal) : sources, options.downloads, async source => {
      signal.throwIfAborted();
      const key = cacheKey(source, options.settings);
      const existingExport = options.output === undefined ? undefined : join(options.output, `${exportStem(source, key)}.json`);
      const cached = !options.force ? await cache.get(key, existingExport) : undefined;
      if (cached) return { key, cached, audio: undefined };
      reporter.status(`Preparing ${source.title}`);
      const work = await mkdtemp(join(directory!, 'input-'));
      try {
        const audio = await prepare(source, work, signal);
        if (source.kind === 'file' && await hashFile(source.location, signal) !== source.fingerprint) {
          throw new Error('The file changed during preparation. Run the command again.');
        }
        return { key, cached: undefined, audio };
      } catch (error) {
        if (!options.keepAudio) await rm(work, { recursive: true, force: true });
        throw error;
      }
    }, () => controller.abort());
    try {
      for await (const item of prepared) {
        signal.throwIfAborted();
        const source = item.input;
        let complete: Completed | undefined;
        try {
          if (item.error) throw item.error;
          const { key, cached, audio } = item.value!;
          let transcript = cached;
          if (!transcript) {
            if (!modelCacheReady && !context.dependencies?.engine) await importModels(home);
            modelCacheReady = true;
            const started = performance.now();
            const words: Word[] = [];
            const count = Math.max(1, Math.ceil((audio!.duration - 0.02) / options.settings.chunkSeconds));
            for (let i = 0; i < count; i++) {
              signal.throwIfAborted();
              reporter.status(`${source.title} · part ${i + 1}/${count}`);
              const start = i * options.settings.chunkSeconds;
              const end = i === count - 1 ? audio!.duration : Math.min(audio!.duration, start + options.settings.chunkSeconds);
              const offset = Math.max(0, start - 1);
              const chunk = count === 1 ? audio!.path : join(audio!.directory, 'chunk.wav');
              if (count > 1) await slice(audio!.path, chunk, offset, Math.min(audio!.duration, end + 1) - offset, signal);
              const result = await engine.transcribe(chunk, signal);
              words.push(...offsetWords(result.words, offset, start, end));
            }
            transcript = { schemaVersion: 1, source, model: { id: options.settings.model, revision: options.settings.revision, license: 'CC-BY-4.0' },
              settings: options.settings, duration: audio!.duration, createdAt: new Date().toISOString(),
              processingSeconds: (performance.now() - started) / 1000, runtime: engine.runtime,
              text: words.map(word => word.text).join(' '), words };
            signal.throwIfAborted();
            await cache.save(key, transcript);
          } else {
            // The identity is stable even when a feed rotates its signed enclosure URL.
            transcript = { ...transcript, source };
          }
          const files = options.output === undefined ? [] : await exportTranscript(transcript, options.output, options.formats, key);
          summary.completed++;
          if (cached) summary.cached++;
          complete = { type: 'transcript', cached: Boolean(cached), transcript, files };
          reporter.note(`✓ ${source.title} · ${cached ? 'cached' : duration(transcript.duration)}${files.length ? ` · ${files.length} files` : ''}`);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof EngineError) throw error;
          summary.failed++;
          reporter.error(`✗ ${source.title}: ${message(error)}`);
          await context.onFailure?.(source, message(error));
        } finally {
          if (!options.keepAudio && item.value?.audio) await rm(item.value.audio.directory, { recursive: true, force: true });
        }
        // Output failures stop the run; they are not failures of the media source.
        if (complete) await context.onResult?.(complete);
      }
    } catch (error) { controller.abort(error); throw error; }
    finally { await prepared.return(); }
    summary.status = summary.failed ? summary.completed ? 'partial' : 'failed' : 'completed';
    reporter.finish(`${summary.completed} completed · ${summary.cached} cached · ${summary.failed} failed${options.output === undefined ? '' : `\n${options.output}`}`);
    return summary;
  } catch (error) { controller.abort(error); reporter.finish('Stopped. Completed transcripts are saved.'); throw error; }
  finally {
    controller.abort();
    try { await engine.close(); }
    finally {
      try {
        if (directory && !options.keepAudio) await rm(directory, { recursive: true, force: true });
        else if (directory) reporter.note(`Audio retained: ${directory}`);
      } finally { await unlock(); }
    }
  }
}
