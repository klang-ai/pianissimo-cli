import { homedir } from 'node:os';
import envPaths from 'env-paths';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import type { Settings } from './types.js';

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const MODELS = {
  sv: { id: 'KlangAI/pianissimo-sv', revision: '8f1f6d8f8bd7482a5ea1d2bfaf6ef5be61597138', filename: 'pianissimo-sv.nemo', chunkSeconds: 120 },
  da: { id: 'KlangAI/pianissimo-da', revision: '1af16817a76d1324e6ee11daad42cb0d6cf7e5b5', filename: 'pianissimo-da.nemo', chunkSeconds: 120 },
} as const;
export type Language = keyof typeof MODELS;
export const LANGUAGES = Object.keys(MODELS) as Language[];
export const MODEL = MODELS.sv.id;
export const REVISION = MODELS.sv.revision;
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SETTINGS: Settings = {
  // Recompute transcripts that may have been produced by the broken MPS build.
  model: MODEL, revision: REVISION, device: 'auto', chunkSeconds: 120, pipelineVersion: 4,
};
export function settingsFor(language: Language): Settings {
  const model = MODELS[language];
  return { ...DEFAULT_SETTINGS, model: model.id, revision: model.revision, chunkSeconds: model.chunkSeconds };
}
export function modelFilename(id: string) {
  const model = Object.values(MODELS).find(model => model.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model.filename;
}
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
