import { homedir } from 'node:os';
import envPaths from 'env-paths';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { Settings } from './types.js';

export const VERSION = '0.2.1';
export const MODEL = 'KlangAI/pianissimo-sv';
export const REVISION = '8f1f6d8f8bd7482a5ea1d2bfaf6ef5be61597138';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SETTINGS: Settings = {
  model: MODEL, revision: REVISION, device: 'auto', chunkSeconds: 120, pipelineVersion: 2,
};
export function paths(home = process.env.PIANISSIMO_HOME ?? envPaths('pianissimo', { suffix: '' }).data) {
  const root = resolve(home);
  return { root, work: join(envPaths('pianissimo', { suffix: '' }).temp, 'runs'),
    transcripts: join(root, 'cache', 'transcripts'), venv: join(root, 'venv'),
    models: join(root, 'models'), logs: join(root, 'logs') };
}
export function legacyHomes() { return [join(homedir(), '.pianissimo'), join(ROOT, '.pianissimo')]; }
export function pythonPath(home = paths()) {
  if (process.env.PIANISSIMO_PYTHON) return process.env.PIANISSIMO_PYTHON;
  const managed = join(home.venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return existsSync(managed) ? managed : 'python3';
}
export function ytdlpPath(home = paths()) {
  if (process.env.PIANISSIMO_YTDLP) return process.env.PIANISSIMO_YTDLP;
  const managed = join(home.venv, process.platform === 'win32' ? 'Scripts/yt-dlp.exe' : 'bin/yt-dlp');
  return existsSync(managed) ? managed : 'yt-dlp';
}
