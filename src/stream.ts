import { spawn } from 'node:child_process';
import { lifecycle, subprocessOptions } from './subprocess.js';

// Reading stdout as an async iterable lets pipe backpressure bound discovery memory.
export async function* streamLines(command: string, args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...subprocessOptions });
  let errors = '', failure: Error | undefined;
  const { stop, closed: treeClosed } = lifecycle(child);
  const closed = new Promise<number | null>(resolve => {
    child.on('error', error => { failure = error; });
    child.on('close', resolve);
  });
  child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-6000); });
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  child.stdout.setEncoding('utf8');
  let pending = '';
  try {
    for await (const chunk of child.stdout) {
      signal.throwIfAborted();
      pending += String(chunk);
      let end: number;
      while ((end = pending.indexOf('\n')) !== -1) {
        if (end > 8 * 1024 * 1024) throw new Error('Source metadata exceeds the 8 MiB line limit.');
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (line) yield line;
      }
      if (pending.length > 8 * 1024 * 1024) throw new Error('Source metadata exceeds the 8 MiB line limit.');
    }
    signal.throwIfAborted();
    if (pending.trim()) yield pending.trim();
    const code = await closed;
    if (failure) throw new Error(`Cannot start ${command}: ${failure.message}. Run pianissimo setup.`);
    if (code !== 0) throw new Error(`Source discovery failed (${code}): ${errors.trim() || 'No error details.'}`);
  } finally {
    stop();
    await closed;
    await treeClosed;
    signal.removeEventListener('abort', stop);
  }
}
