import { existsSync } from 'node:fs';
import { mkdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { MODEL, REVISION, ROOT, paths, pythonPath } from './config.js';
import { run } from './process.js';
import { importModels } from './state.js';
import { message } from './util.js';
import { Reporter } from './reporter.js';
import { acquireLock } from './lock.js';
import { checkYtdlp } from './ytdlp.js';

interface Check { name: string; ok: boolean; detail: string; fix?: string }

export async function findPython(requested: string | undefined, signal: AbortSignal) {
  const candidates = requested ? [requested] : ['python3.12', 'python3', 'python3.13', 'python3.11', 'python3.10'];
  for (const command of candidates) {
    try {
      const version = await run(command, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], { signal, timeoutMs: 15000 });
      if (/^3\.(10|11|12|13)$/.test(version)) return command;
      if (requested) throw new Error(`Python ${version} is not supported.`);
    } catch (error) {
      signal.throwIfAborted();
      if (requested) throw new Error(`${message(error)} Use --python with a Python 3.10–3.13 interpreter (3.12 recommended).`);
    }
  }
  throw new Error('No supported Python found. Install Python 3.10–3.13 (3.12 recommended), or use setup --python /path/to/python.');
}

export async function useCpuTorch(signal: AbortSignal, platform: NodeJS.Platform = process.platform) {
  if (platform !== 'linux') return false;
  try {
    const gpus = await run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { signal, timeoutMs: 5000 });
    return !gpus.trim();
  } catch {
    signal.throwIfAborted();
    return true;
  }
}

function checkpointPath(home = paths()) {
  return join(home.models, `models--${MODEL.replace('/', '--')}`, 'snapshots', REVISION, 'pianissimo-sv.nemo');
}
async function hasCheckpoint(home = paths()) {
  return stat(checkpointPath(home)).then(info => info.isFile() && info.size > 0, () => false);
}

export function requireModelSpace(available: number) {
  if (available < 3 * 1024 ** 3) {
    throw new Error(`Not enough disk space: ${(available / 1024 ** 3).toFixed(1)} GiB available. The model needs at least 3 GiB free, plus additional space for Python dependencies and temporary audio. Free disk space or set PIANISSIMO_HOME to a larger drive.`);
  }
}

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
  const cached = await hasCheckpoint(home);
  checks.push({ name: 'Model cache', ok: cached, detail: checkpointPath(home), ...(!cached ? { fix: 'Run pianissimo setup.' } : {}) });
  signal.throwIfAborted();
  return checks;
}
export async function setup(options: { python?: string; from?: string; signal: AbortSignal; reporter: Reporter }) {
  const home = paths();
  await mkdir(home.root, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const unlock = await acquireLock(home.root, error => controller.abort(error));
  try {
    if (process.env.PIANISSIMO_PYTHON) throw new Error('PIANISSIMO_PYTHON selects your own environment. Install worker/requirements.txt there, or unset it before managed setup.');
    options.reporter.start('Setup');
    for (const tool of ['ffmpeg', 'ffprobe']) {
      try { await run(tool, ['-version'], { signal, timeoutMs: 15000 }); }
      catch (error) {
        signal.throwIfAborted();
        throw new Error(`${tool} is required. Install FFmpeg (Ubuntu/Debian: sudo apt install ffmpeg; macOS: brew install ffmpeg). ${message(error)}`);
      }
    }
    if (options.from && !existsSync(join(options.from, 'models'))) throw new Error('--from must point to a Pianissimo home containing a models directory.');
    const imported = await importModels(home, options.from ? [options.from] : undefined);
    if (imported) options.reporter.note(`Reused ${imported} model snapshot(s) from an earlier installation.`);
    if (!await hasCheckpoint(home)) {
      const disk = await statfs(home.root);
      requireModelSpace(disk.bavail * disk.bsize);
    }
    let uv = false;
    try { await run('uv', ['--version'], { signal }); uv = true; } catch { /* pip fallback */ }
    const python = join(home.venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const interpreter = await findPython(options.python ?? (existsSync(python) ? python : undefined), signal);
    if (!existsSync(python)) {
      options.reporter.status('Creating the Python environment.');
      try {
        if (uv) await run('uv', ['venv', '--python', interpreter, home.venv], { signal });
        else await run(interpreter, ['-m', 'venv', home.venv], { signal });
      } catch (error) {
        signal.throwIfAborted();
        throw new Error(`Could not create the Python environment. Install uv, or Python venv support (Ubuntu/Debian: sudo apt install python3-venv). ${message(error)}`);
      }
    }
    const install = (args: string[]) => uv
      ? run('uv', ['pip', 'install', '--python', python, ...args], { signal })
      : run(python, ['-m', 'pip', 'install', ...args], { signal });
    if (await useCpuTorch(signal)) {
      options.reporter.status('No NVIDIA GPU detected. Installing CPU-only PyTorch.');
      await install(['torch>=2.6.0', 'torchaudio>=2.6.0', '--index-url', 'https://download.pytorch.org/whl/cpu']);
    }
    options.reporter.status('Installing PyTorch and NeMo. This can take several minutes.');
    await install(['-r', join(ROOT, 'worker/requirements.txt')]);
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
