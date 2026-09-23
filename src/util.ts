import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Settings, Source } from './types.js';

export function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
export async function hashFile(path: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
export function cacheKey(source: Source, settings: Settings) {
  return digest(JSON.stringify({ source: source.fingerprint, ...settings }));
}
export function safeName(value: string) {
  const name = value.normalize('NFKC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
  let result = '';
  // Keep names portable across byte-limited filesystems without splitting a
  // Unicode code point. Leave room for source/settings suffixes and extensions.
  for (const character of name || 'untitled') {
    if (result.length + character.length > 90 || Buffer.byteLength(result + character, 'utf8') > 160) break;
    result += character;
  }
  return result.replace(/[. ]+$/g, '');
}
export function sourceStem(source: Source) {
  return `${safeName(source.title)}--${digest(source.id).slice(0, 12)}`;
}
export async function atomicWrite(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.pianissimo-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
export function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
export function duration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
export function cleanTerminal(text: string) { return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '); }
