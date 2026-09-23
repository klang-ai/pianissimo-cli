import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lifecycle, subprocessOptions } from './subprocess.js';
import { paths, pythonPath, ROOT } from './config.js';
import type { Engine, Recognition, Runtime, Settings, Word } from './types.js';

// A dead/misconfigured worker cannot process any later source in this run.
export class EngineError extends Error {}

export function parseRecognition(value: unknown): Recognition {
  if (!value || typeof value !== 'object') throw new Error('Invalid response from the inference worker.');
  const obj = value as Record<string, unknown>;
  if (typeof obj.text !== 'string' || !Array.isArray(obj.words)) throw new Error('The inference worker returned an invalid transcript.');
  let last = -1;
  for (const item of obj.words) {
    const word = item as Word;
    if (!word || typeof word.text !== 'string' || !word.text.trim() || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start || word.start < last) {
      throw new Error('The inference worker returned invalid word timestamps.');
    }
    last = word.start;
  }
  if (obj.text.trim() && !obj.words.length) throw new Error('The transcript has no word timestamps. Check your NeMo installation.');
  return { text: obj.text, words: obj.words as Word[] };
}

export class NemoEngine implements Engine {
  runtime?: Runtime;
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending?: { id: string; resolve: (value: Recognition) => void; reject: (reason: Error) => void };
  private failure?: Error;
  private stopped = false;
  private exit?: Promise<void>;
  private stop?: () => void;
  constructor(private settings: Settings, private home = paths(), private onStatus: (text: string) => void = () => {}) {}
  private start(signal: AbortSignal) {
    if (this.ready) return this.ready;
    signal.throwIfAborted();
    this.onStatus('Starting the Pianissimo inference worker.');
    mkdirSync(this.home.logs, { recursive: true, mode: 0o700 });
    const logPath = join(this.home.logs, `worker-${Date.now()}-${process.pid}.log`);
    const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    log.on('error', () => {});
    const child = spawn(pythonPath(this.home), ['-u', join(ROOT, 'worker/pianissimo_worker.py'),
      '--model', this.settings.model, '--revision', this.settings.revision,
      '--device', this.settings.device, '--cache-dir', this.home.models], {
      stdio: ['pipe', 'pipe', 'pipe'], ...subprocessOptions,
      env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' },
    });
    this.child = child;
    const processLifecycle = lifecycle(child);
    this.exit = processLifecycle.closed;
    this.stop = processLifecycle.stop;
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2500); log.write(data); });
    this.ready = new Promise<void>((resolve, reject) => {
      let isReady = false;
      const fail = (error: Error) => {
        this.failure ??= new EngineError(error.message, { cause: error });
        reject(this.failure);
        this.pending?.reject(this.failure); this.pending = undefined;
        this.stop?.();
      };
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        try {
          const data = JSON.parse(line) as Record<string, unknown>;
          if (data.type === 'status' && typeof data.message === 'string') {
            this.onStatus(data.message);
          } else if (data.type === 'ready') {
            if (!['cpu', 'cuda', 'mps'].includes(String(data.device))) throw new Error('The worker reported an unknown device.');
            this.runtime = { device: data.device as Runtime['device'],
              deviceName: typeof data.deviceName === 'string' ? data.deviceName : undefined,
              torch: typeof data.torch === 'string' ? data.torch : undefined,
              nemo: typeof data.nemo === 'string' ? data.nemo : undefined };
            isReady = true;
            this.onStatus(`Pianissimo ready on ${this.runtime.device}${this.runtime.deviceName ? ` (${this.runtime.deviceName})` : ''}.`);
            resolve();
          }
          else if (data.type === 'error') {
            const error = new Error(`${String(data.error)}\nWorker log: ${logPath}`);
            if (!isReady) fail(error);
            else if (this.pending && data.id === this.pending.id) { this.pending.reject(error); this.pending = undefined; }
            else fail(error);
          } else if (data.type === 'result' && this.pending && data.id === this.pending.id) {
            const result = parseRecognition(data);
            this.pending.resolve(result); this.pending = undefined;
          } else throw new Error('Unexpected message from the inference worker.');
        } catch (error) { fail(error as Error); this.stop?.(); }
      });
      child.stdin.on('error', error => fail(error));
      child.on('error', error => fail(new Error(`Cannot start the inference worker: ${error.message}. Run pianissimo setup.`)));
      child.on('close', code => {
        lines.close(); log.end();
        if (!this.stopped || !isReady || this.pending) fail(new Error(`Inference worker stopped (${code}). ${stderr.trim()}\nRun pianissimo doctor. Log: ${logPath}`));
      });
    });
    return this.ready;
  }
  async transcribe(path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
    const abort = () => { void this.close(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      try { await this.start(signal); }
      catch (error) {
        signal.throwIfAborted();
        this.failure ??= new EngineError(error instanceof Error ? error.message : String(error), { cause: error });
        throw this.failure;
      }
      signal.throwIfAborted();
      if (this.failure) throw this.failure;
      if (this.pending) throw new Error('The inference worker is already processing audio.');
      return await new Promise<Recognition>((resolve, reject) => {
        const id = randomUUID();
        this.pending = { id, resolve, reject };
        this.child!.stdin.write(JSON.stringify({ type: 'transcribe', id, path }) + '\n');
      });
    } finally { signal.removeEventListener('abort', abort); }
  }
  async close() {
    this.stopped = true;
    this.stop?.();
    await this.exit;
  }
}
