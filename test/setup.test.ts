import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findPython, requireModelSpace, setup, useCpuTorch } from '../src/setup.js';
import { MODEL, REVISION } from '../src/config.js';
import { Reporter } from '../src/reporter.js';

const signal = () => new AbortController().signal;
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'pianissimo-setup-'));
  const bin = join(root, 'bin'); await mkdir(bin);
  const previous = { ...process.env };
  process.env.PATH = bin;
  process.env.PIANISSIMO_HOME = join(root, 'home');
  delete process.env.PIANISSIMO_PYTHON;
  delete process.env.PIANISSIMO_YTDLP;
  t.after(async () => { process.env = previous; await rm(root, { recursive: true, force: true }); });
  const executable = async (name: string, code: string) => {
    const path = join(bin, name);
    await writeFile(path, `#!${process.execPath}\n${code}\n`, { mode: 0o700 });
    return path;
  };
  return { root, bin, executable };
}

test('setup discovers supported Python, but never silently replaces an explicit interpreter', { skip: process.platform === 'win32' }, async t => {
  const { executable } = await fixture(t);
  await executable('python3', "console.log('3.11')");
  assert.equal(await findPython(undefined, signal()), 'python3');
  await executable('python3.12', "console.log('3.12')");
  assert.equal(await findPython(undefined, signal()), 'python3.12');
  assert.equal(await findPython('python3', signal()), 'python3');
  await executable('python3.12', "console.log('3.14')");
  assert.equal(await findPython(undefined, signal()), 'python3');
  await assert.rejects(findPython('python3.12', signal()), /Python 3.14 is not supported/);
  await assert.rejects(findPython('missing-python', signal()), /Use --python/);
  await executable('python3', "console.log('3.9')");
  await assert.rejects(findPython(undefined, signal()), /No supported Python found/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(findPython(undefined, controller.signal), /abort/i);
});

test('CPU wheels are selected only on Linux without a working NVIDIA GPU', { skip: process.platform === 'win32' }, async t => {
  const { executable } = await fixture(t);
  assert.equal(await useCpuTorch(signal(), 'linux'), true);
  assert.equal(await useCpuTorch(signal(), 'darwin'), false);
  await executable('nvidia-smi', "console.log('NVIDIA GPU')");
  assert.equal(await useCpuTorch(signal(), 'linux'), false);
  await executable('nvidia-smi', 'process.exit(1)');
  assert.equal(await useCpuTorch(signal(), 'linux'), true);
  await executable('nvidia-smi', 'process.exit(0)');
  assert.equal(await useCpuTorch(signal(), 'linux'), true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(useCpuTorch(controller.signal, 'linux'), /abort/i);
});

test('low storage is rejected before a multi-gigabyte model download', () => {
  assert.throws(() => requireModelSpace(717 * 1024 ** 2), /Not enough disk space.*PIANISSIMO_HOME/);
  assert.doesNotThrow(() => requireModelSpace(3 * 1024 ** 3));
});

test('setup creates and reuses managed environments with both uv and pip', { skip: process.platform === 'win32' }, async t => {
  for (const installer of ['uv', 'pip']) {
    await t.test(installer, async t => {
      const { root, executable } = await fixture(t);
      const log = join(root, 'calls.jsonl');
      const source = `
        const fs = require('node:fs'), path = require('node:path');
        const args = process.argv.slice(2);
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([path.basename(process.argv[1]), ...args]) + '\\n');
        if (args.includes('-c')) console.log('3.12');
        else if (args.includes('venv')) {
          const bin = path.join(args.at(-1), 'bin'); fs.mkdirSync(bin, {recursive:true});
          fs.copyFileSync(__filename, path.join(bin, 'python'));
        } else if (args.includes('--check')) console.log(JSON.stringify({ok:true, device:'cpu', python:'3.12'}));
        else if (args.includes('--download')) console.log(JSON.stringify({ok:true, checkpoint:'/cached/model.nemo'}));
      `;
      await executable('python3', source);
      if (installer === 'uv') await executable('uv', source);
      for (const tool of ['ffmpeg', 'ffprobe']) await executable(tool, "console.log('test version')");
      await executable('yt-dlp', "console.log('2026.08.19')");
      const snapshot = join(process.env.PIANISSIMO_HOME!, 'models', `models--${MODEL.replace('/', '--')}`, 'snapshots', REVISION);
      await mkdir(snapshot, { recursive: true });
      await writeFile(join(snapshot, 'pianissimo-sv.nemo'), 'Existing checkpoint');
      const options = { signal: signal(), reporter: new Reporter(true) };
      assert.equal((await setup(options)).device, 'cpu');
      // Rerunning must use the managed interpreter, even if system Python disappears.
      await executable('python3', 'process.exit(1)');
      assert.equal((await setup(options)).device, 'cpu');
      const calls: string[][] = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(calls.filter(args => args.includes('venv')).length, 1);
      const installs = calls.filter(args => args.includes('install'));
      if (process.platform === 'linux') {
        assert.equal(installs.filter(args => args.includes('https://download.pytorch.org/whl/cpu')).length, 2);
        assert.ok(installs[0]!.includes('torchaudio>=2.6.0'));
      } else assert.ok(installs.every(args => !args.includes('--index-url')));
      assert.equal(installs.filter(args => args.includes('-r')).length, 2);
      assert.ok(calls.some(args => args.includes('--check')));
      assert.ok(calls.some(args => args.includes('--download')));
    });
  }
});
