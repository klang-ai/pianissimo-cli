import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MODEL, REVISION, ROOT, paths, pythonPath } from './config.js';
import { run } from './process.js';
import { importModels } from './state.js';
import { message } from './util.js';
import { Reporter } from './reporter.js';
import { acquireLock } from './lock.js';
import { checkYtdlp } from './ytdlp.js';

interface Check { name: string; ok: boolean; detail: string; fix?: string }
export async function doctor(signal: AbortSignal): Promise<Check[]> {
  const home = paths();
  const checks = await Promise.all([
    ['FFmpeg', 'ffmpeg', ['-version'], 'Install FFmpeg: https://ffmpeg.org/download.html'],
    ['FFprobe', 'ffprobe', ['-version'], 'Install FFmpeg, which includes ffprobe.'],
  ].map(async ([name, command, args, fix]) => {
    try {
      const result = await run(command as string, args as string[], { signal, timeoutMs: 15000 });
      return { name: name as string, ok: true, detail: result.split('\n')[0]! };
    } catch (error) { return { name: name as string, ok: false, detail: message(error), fix: fix as string }; }
  }));
  try { checks.push({ name: 'Media URLs', ok: true, detail: `yt-dlp ${await checkYtdlp(signal)}` }); }
  catch (error) { checks.push({ name: 'Media URLs', ok: false, detail: message(error), fix: 'Run pianissimo setup to install the supported yt-dlp version.' }); }
  try {
    const result = await run(pythonPath(home), [join(ROOT, 'worker/pianissimo_worker.py'), '--check', '--cache-dir', home.models], { signal, timeoutMs: 120000 });
    const info = JSON.parse(result) as { nemo: string; torch: string; cuda: boolean; mps: boolean; device: string; deviceName: string; python: string };
    checks.push({ name: 'Inference', ok: true, detail: `Python ${info.python} · NeMo ${info.nemo} · PyTorch ${info.torch} · ${info.device} (${info.deviceName})` });
  } catch (error) {
    checks.push({ name: 'Inference', ok: false, detail: message(error), fix: 'Run pianissimo setup, or set PIANISSIMO_PYTHON to your NeMo environment.' });
  }
  const checkpoint = join(home.models, `models--${MODEL.replace('/', '--')}`, 'snapshots', REVISION, 'pianissimo-sv.nemo');
  const cached = await stat(checkpoint).then(info => info.isFile() && info.size > 0, () => false);
  checks.push({ name: 'Model cache', ok: cached, detail: checkpoint, ...(!cached ? { fix: 'Run pianissimo setup.' } : {}) });
  signal.throwIfAborted();
  return checks;
}
export async function setup(options: { python: string; from?: string; signal: AbortSignal; reporter: Reporter }) {
  const home = paths();
  await mkdir(home.root, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const unlock = await acquireLock(home.root, error => controller.abort(error));
  try {
    if (process.env.PIANISSIMO_PYTHON) throw new Error('PIANISSIMO_PYTHON selects your own environment. Install worker/requirements.txt there, or unset it before managed setup.');
    const version = await run(options.python, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], { signal });
    if (!/^3\.(10|11|12|13)$/.test(version)) throw new Error(`Python ${version} is not supported by this installer. Use --python python3.12.`);
    options.reporter.start('Setup');
    for (const tool of ['ffmpeg', 'ffprobe']) await run(tool, ['-version'], { signal, timeoutMs: 15000 });
    if (options.from && !existsSync(join(options.from, 'models'))) throw new Error('--from must point to a Pianissimo home containing a models directory.');
    const imported = await importModels(home, options.from ? [options.from] : undefined);
    if (imported) options.reporter.note(`Reused ${imported} model snapshot(s) from an earlier installation.`);
    let uv = false;
    try { await run('uv', ['--version'], { signal }); uv = true; } catch { /* pip fallback */ }
    const python = join(home.venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!existsSync(python)) {
      options.reporter.status('Creating the Python environment.');
      if (uv) await run('uv', ['venv', '--python', options.python, home.venv], { signal });
      else await run(options.python, ['-m', 'venv', home.venv], { signal });
    }
    options.reporter.status('Installing PyTorch and NeMo. This can take several minutes.');
    if (uv) await run('uv', ['pip', 'install', '--python', python, '-r', join(ROOT, 'worker/requirements.txt')], { signal });
    else await run(python, ['-m', 'pip', 'install', '-r', join(ROOT, 'worker/requirements.txt')], { signal });
    options.reporter.status('Checking the inference environment.');
    const check = await run(python, [join(ROOT, 'worker/pianissimo_worker.py'), '--check', '--cache-dir', home.models], { signal, timeoutMs: 120000 });
    options.reporter.status('Checking the model cache.');
    await downloadModel(signal, text => options.reporter.status(text));
    await checkYtdlp(signal);
    options.reporter.finish('Ready. Run pianissimo <file-or-url> to transcribe.');
    return JSON.parse(check) as Record<string, unknown>;
  } catch (error) { options.reporter.finish('Setup stopped. Run it again after resolving the error.'); throw error; }
  finally { await unlock(); }
}
export async function downloadModel(signal: AbortSignal, onStatus: (text: string) => void = () => {}) {
  const home = paths();
  let result: Record<string, unknown> | undefined;
  await run(pythonPath(home), [join(ROOT, 'worker/pianissimo_worker.py'), '--download',
    '--model', MODEL, '--revision', REVISION, '--cache-dir', home.models], { signal, onLine: line => {
      const data = JSON.parse(line) as Record<string, unknown>;
      if (data.type === 'status' && typeof data.message === 'string') onStatus(data.message);
      else if (data.ok === true && typeof data.checkpoint === 'string') result = data;
      else if (data.type === 'error') throw new Error(String(data.error));
      else throw new Error('Unexpected response while resolving the model checkpoint.');
    } });
  if (!result) throw new Error('The model worker did not return a checkpoint.');
  return result;
}
