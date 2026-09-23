import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, cacheKey } from './util.js';
import { parseRecognition } from './engine.js';
import type { Transcript } from './types.js';

export class TranscriptCache {
  constructor(private directory: string) {}
  private path(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid transcript cache key.');
    return join(this.directory, key.slice(0, 2), `${key}.json`);
  }
  async get(key: string, existingExport?: string): Promise<Transcript | undefined> {
    for (const path of [this.path(key), existingExport].filter((p): p is string => Boolean(p))) {
      try {
        const value = JSON.parse(await readFile(path, 'utf8')) as Transcript;
        if (value.schemaVersion !== 1 || !Number.isFinite(value.duration) || value.duration <= 0 ||
            !value.source || !value.settings || value.model?.id !== value.settings.model ||
            value.model?.revision !== value.settings.revision || cacheKey(value.source, value.settings) !== key) continue;
        parseRecognition(value);
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code && !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code!)) throw error;
        // Malformed JSON or an obsolete schema is a cache miss, never a completed result.
      }
    }
  }
  async save(key: string, value: Transcript) { await atomicWrite(this.path(key), JSON.stringify(value) + '\n'); }
}
