import { constants } from 'node:fs';
import { copyFile, link, mkdir, readdir, stat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { legacyHomes, MODEL, paths } from './config.js';

// Import only complete snapshots. Hardlinks/reflinks avoid downloading or duplicating weights.
export async function importModels(home = paths(), candidates = legacyHomes()) {
  let imported = 0;
  const repository = `models--${MODEL.replace('/', '--')}`;
  for (const candidate of candidates) {
    if (resolve(candidate) === home.root) continue;
    const snapshots = join(candidate, 'models', repository, 'snapshots');
    let revisions;
    try { revisions = await readdir(snapshots); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const revision of revisions) {
      if (!/^[a-f0-9]{40}$/.test(revision)) continue;
      const source = join(snapshots, revision, 'pianissimo-sv.nemo');
      const directory = join(home.models, repository, 'snapshots', revision);
      const target = join(directory, 'pianissimo-sv.nemo');
      try { if (!(await stat(source)).isFile()) continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { await link(await realpath(source), target); imported++; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') continue;
        if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(code ?? '')) throw error;
        // Copy to a temporary file first so interrupted imports never become valid snapshots.
        const temp = `${target}.${process.pid}.tmp`;
        const { rename, rm } = await import('node:fs/promises');
        try {
          await copyFile(source, temp, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
          await rename(temp, target); imported++;
        } finally { await rm(temp, { force: true }); }
      }
    }
  }
  return imported;
}
