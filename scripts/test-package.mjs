import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'pianissimo-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, extra = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...extra });
try {
  const [packed] = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', root]));
  const files = packed.files.map(file => file.path);
  for (const required of ['LICENSE', 'NOTICE', 'README.md', 'bin/pianissimo.js', 'dist/cli.js', 'dist/feeds.js', 'worker/pianissimo_worker.py', 'worker/model_cache.py', 'worker/runtime.py', 'worker/requirements.txt']) assert.ok(files.includes(required), `Missing ${required}`);
  assert.ok(!files.some(file => /(?:REVIEW|VALIDATION)\.md$/.test(file)), 'Local review notes must not be published');
  assert.ok(files.every(file => !/\.pianissimo|node_modules|__pycache__|dist\/(?:store|youtube)\.|\.sqlite/.test(file)), 'Unexpected state or obsolete code in the package');
  const prefix = join(root, 'installed');
  run(npm, ['install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(root, packed.filename)]);
  const entry = join(prefix, 'node_modules', '@klangai', 'pianissimo-cli', 'bin', 'pianissimo.js');
  const home = join(root, 'home');
  const env = { ...process.env, PIANISSIMO_HOME: home };
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(run(process.execPath, [entry, '--version'], { env }).trim(), packageJson.version);
  assert.match(run(process.execPath, [entry, '--help'], { env }), /podcast/);
  const source = join(root, 'clip.wav'); await writeFile(source, 'Only metadata is read during dry runs.');
  const records = run(process.execPath, [entry, source, '--dry-run', '--json'], { env }).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records[0].type, 'source'); assert.equal(records.at(-1).count, 1);
  console.log(`Package verified: ${packed.filename}, ${files.length} files, ${packed.size} bytes. Isolated production install and CLI entrypoint passed.`);
} finally { await rm(root, { recursive: true, force: true }); }
