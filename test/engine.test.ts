import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NemoEngine } from '../src/engine.js';
import { DEFAULT_SETTINGS, paths } from '../src/config.js';

async function worker(t: { after: (fn: () => Promise<void>) => void }, source: string, device = DEFAULT_SETTINGS.device) {
  const root = await mkdtemp(join(tmpdir(), 'pianissimo-engine-'));
  const home = paths(root);
  const bin = join(home.venv, 'bin'); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'python'), `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  const engine = new NemoEngine({ ...DEFAULT_SETTINGS, device }, home);
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  return engine;
}
test('worker protocol accepts cache status, reuses one process, and isolates stderr', { skip: process.platform === 'win32' }, async t => {
  const engine = await worker(t, `
    const readline = require('node:readline'); let count = 0;
    console.error('A native library log.');
    console.log(JSON.stringify({type:'status',message:'Using Pianissimo cached on disk: /cache/model.nemo'}));
    console.log(JSON.stringify({type:'status',message:'Loading Pianissimo from disk onto cpu.'}));
    console.log(JSON.stringify({type:'ready',device:'cpu'}));
    readline.createInterface({input:process.stdin}).on('line', line => {
      const req=JSON.parse(line); count++;
      console.log(JSON.stringify({type:'result', id:req.id,text:String(count),words:[{text:String(count),start:0,end:1}]}));
    });
  `);
  const signal = new AbortController().signal;
  assert.equal((await engine.transcribe('/tmp/one.wav', signal)).text, '1');
  assert.equal((await engine.transcribe('/tmp/two.wav', signal)).text, '2');
});

test('worker startup failure and malformed messages reject instead of hanging', { skip: process.platform === 'win32' }, async t => {
  const failed = await worker(t, "console.error('Missing dependency'); process.exit(3);");
  await assert.rejects(failed.transcribe('/tmp/input.wav', new AbortController().signal), /Missing dependency/);
  const malformed = await worker(t, "console.log('not JSON'); setInterval(()=>{},1000);");
  await assert.rejects(malformed.transcribe('/tmp/input.wav', new AbortController().signal), /JSON|Unexpected token/);
});

test('cancelling a model load terminates the worker and rejects the request', { skip: process.platform === 'win32' }, async t => {
  const engine = await worker(t, 'setInterval(()=>{},1000);');
  const controller = new AbortController();
  const pending = engine.transcribe('/tmp/input.wav', controller.signal);
  controller.abort();
  await assert.rejects(pending, /abort|stopped/i);
});

test('explicit MPS is sent to the worker and resolved hardware is recorded for auto', { skip: process.platform === 'win32' }, async t => {
  for (const requested of ['mps', 'auto'] as const) {
    const engine = await worker(t, `
      const args = process.argv.slice(2);
      if (args[args.indexOf('--device') + 1] !== '${requested}') process.exit(2);
      console.log(JSON.stringify({type:'ready',device:'mps',deviceName:'Apple GPU',torch:'test',nemo:'test'}));
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const req = JSON.parse(line);
        console.log(JSON.stringify({type:'result',id:req.id,text:'Hej',words:[{text:'Hej',start:0,end:1}]}));
      });
    `, requested);
    await engine.transcribe('/tmp/input.wav', new AbortController().signal);
    assert.deepEqual(engine.runtime, { device: 'mps', deviceName: 'Apple GPU', torch: 'test', nemo: 'test' });
  }
});
