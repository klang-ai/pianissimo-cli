import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';

export async function acquireLock(root: string, onCompromised?: (error: Error) => void) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    return await lock(root, { realpath: false, lockfilePath: join(root, '.run.lock'),
      stale: 30000, update: 10000, retries: 0, onCompromised });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new Error('Another Pianissimo process is using this home. Wait for it to finish. After a crash, retry in 30 seconds.');
    }
    throw error;
  }
}
