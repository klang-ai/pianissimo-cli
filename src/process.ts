import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { lifecycle, subprocessOptions } from './subprocess.js';

export interface RunOptions {
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  timeoutMs?: number;
  maxOutput?: number;
  env?: NodeJS.ProcessEnv;
}
export async function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? process.env, ...subprocessOptions });
    let output = '', errors = '', failure: Error | undefined;
    const { stop, closed } = lifecycle(child);
    const abort = () => { failure = new Error('Interrupted. Completed transcripts are saved.'); stop(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = options.timeoutMs ? setTimeout(() => { failure = new Error(`${command} timed out.`); stop(); }, options.timeoutMs) : undefined;
    const lines = options.onLine ? createInterface({ input: child.stdout }) : undefined;
    lines?.on('line', line => {
      try { options.onLine!(line); } catch (error) { failure = error as Error; stop(); }
    });
    child.stdout.on('data', (data: Buffer) => {
      if (options.onLine) return;
      output += data.toString();
      if (output.length > (options.maxOutput ?? 8 * 1024 * 1024)) { failure = new Error(`${command} returned too much output.`); stop(); }
    });
    child.stderr.on('data', (data: Buffer) => { errors = (errors + data.toString()).slice(-6000); });
    child.on('error', error => { failure = new Error(`Cannot start ${command}: ${error.message}. Run pianissimo doctor.`); });
    child.on('close', async code => {
      await closed;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      lines?.close();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} exited with code ${code}: ${errors.trim() || 'No error details.'}`));
      else resolve(output.trim());
    });
    if (options.signal?.aborted) abort();
  });
}
