import { Command, Option, InvalidArgumentError } from 'commander';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { DEFAULT_SETTINGS, VERSION, paths } from './config.js';
import { discoverSources } from './sources.js';
import { runSources } from './pipeline.js';
import { render } from './export.js';
import { Reporter } from './reporter.js';
import { doctor, setup } from './setup.js';
import { message } from './util.js';
import type { Device, Format } from './types.js';

const abort = new AbortController();
process.once('SIGINT', () => abort.abort(new Error('Interrupted. Completed transcripts are saved.')));
process.once('SIGTERM', () => abort.abort(new Error('Terminated. Completed transcripts are saved.')));
let brokenPipe = false;
process.stdout.on('error', error => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') brokenPipe = true;
  abort.abort(error);
});
async function writeOutput(text: string) {
  if (!process.stdout.write(text)) await once(process.stdout, 'drain', { signal: abort.signal });
}
async function output(value: unknown) { await writeOutput(JSON.stringify(value) + '\n'); }
const integer = (min: number, max: number) => (value: string) => {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new InvalidArgumentError(`Use an integer from ${min} to ${max}.`);
  }
  return Number(value);
};
const revision = (value: string) => {
  if (!/^[a-f\d]{40}$/i.test(value)) throw new InvalidArgumentError('Use an immutable 40-character commit SHA.');
  return value.toLowerCase();
};
const formats = (value: string): Format[] => {
  const values = value.split(',').map(v => v.trim());
  if (!values.length || values.some(v => !['txt', 'md', 'json', 'srt', 'vtt'].includes(v))) throw new InvalidArgumentError('Choose txt, md, json, srt or vtt, separated by commas.');
  return [...new Set(values)] as Format[];
};
interface Options {
  output: string; format: Format[]; device: Device; force: boolean; recursive: boolean; limit?: number;
  dryRun: boolean; json: boolean; quiet: boolean; revision: string; chunkSeconds: number;
  downloads: number; keepAudio: boolean; source: 'auto' | 'feed' | 'web';
}
function sourceOptions(command: Command) {
  return command.argument('[source]', 'file, folder, podcast RSS feed or media URL')
    .option('-o, --output <directory>', 'where to save transcripts', './transcripts')
    .option('-f, --format <formats>', 'file formats: txt, md, json, srt, vtt; first format also goes to stdout', formats, ['txt'])
    .addOption(new Option('--device <device>', 'inference device').choices(['auto', 'cpu', 'mps', 'cuda']).default('auto'))
    .option('--force', 'transcribe again, bypassing the transcript cache')
    .option('-r, --recursive', 'include subfolders')
    .option('--limit <count>', 'maximum source entries to process', integer(1, 1000000))
    .option('--dry-run', 'list sources without downloading audio or loading the model')
    .option('--json', 'stream JSON events and summary instead of formatted transcripts')
    .option('-q, --quiet', 'only show errors on stderr')
    .addOption(new Option('--source <type>', 'override URL detection').choices(['auto', 'feed', 'web']).default('auto').hideHelp())
    .addOption(new Option('--revision <sha>', 'immutable model revision').argParser(revision).default(DEFAULT_SETTINGS.revision).hideHelp())
    .addOption(new Option('--chunk-seconds <seconds>', 'audio length per inference call').argParser(integer(15, 600)).default(DEFAULT_SETTINGS.chunkSeconds).hideHelp())
    .addOption(new Option('--downloads <count>', 'number of inputs prepared ahead').argParser(integer(1, 4)).default(2).hideHelp())
    .addOption(new Option('--keep-audio', 'retain temporary audio').hideHelp());
}
const program = sourceOptions(new Command().enablePositionalOptions().name('pianissimo').description('Swedish speech to text. Give it a file, folder, podcast feed or media URL.').version(VERSION));
program.addHelpText('after', `\nExamples:\n  pianissimo interview.wav\n  pianissimo ./recordings --recursive --format txt,srt\n  pianissimo 'https://www.youtube.com/@svt/videos' --limit 5\n  pianissimo 'https://example.com/podcast.xml' --limit 3\n  pianissimo 'https://www.svtplay.se/video/…'\n\nRun pianissimo setup once. Use --help-all for advanced options.`);
program.option('--help-all', 'show advanced options');
program.on('option:help-all', () => {
  for (const option of program.options) option.hidden = false;
  program.help();
});
async function transcribe(input: string | undefined, options: Options, command: Command) {
  if (!input) { command.help(); return; }
  // Alias options after the subcommand belong to it. Explicit root options before
  // a subcommand remain defaults unless the subcommand explicitly overrides them.
  if (command !== program) {
    for (const key of Object.keys(program.opts())) {
      if (program.getOptionValueSource(key) === 'cli' && command.getOptionValueSource(key) !== 'cli') {
        (options as unknown as Record<string, unknown>)[key] = program.opts()[key];
      }
    }
  }
  const reporter = new Reporter(options.quiet);
  const discover = (signal: AbortSignal) => discoverSources(input, { signal, recursive: options.recursive, limit: options.limit,
    sourceType: options.source, onWarning: text => reporter.note(text) });
  if (options.dryRun) {
    let count = 0;
    for await (const source of discover(abort.signal)) {
      count++;
      if (options.json) await output({ type: 'source', source });
      else reporter.note(`${count}. ${source.title}\n   ${source.location}`);
    }
    if (options.json) await output({ type: 'plan', count });
    else reporter.note(`${count} sources. No audio downloaded.`);
    return;
  }
  const result = await runSources(discover, { output: resolve(options.output), formats: options.format,
    settings: { ...DEFAULT_SETTINGS, revision: options.revision, device: options.device, chunkSeconds: options.chunkSeconds },
    downloads: options.downloads, keepAudio: options.keepAudio, force: options.force }, {
    signal: abort.signal, reporter,
    onResult: options.json ? output : async result => {
      const format = options.format[0]!;
      // One JSON object per source keeps collections streamable without buffering them.
      if (format === 'json') await output(result.transcript);
      else await writeOutput(render(result.transcript, format));
    },
    onFailure: options.json ? (source, error) => output({ type: 'error', source, error }) : undefined,
  });
  if (options.json) await output(result);
  if (result.failed) process.exitCode = 2;
}
program.action(transcribe);
// Compatibility aliases are deliberately absent from the main help.
for (const name of ['transcribe', 'youtube']) {
  sourceOptions(program.command(name, { hidden: true })).action(transcribe);
}
program.command('setup').description('Install the inference environment and cache the model')
  .option('--python <command>', 'Python 3.10–3.13 interpreter', 'python3.12')
  .option('--from <directory>', 'import a model cache from an older installation')
  .option('--json', 'print setup details as JSON')
  .action(async opts => {
    const result = await setup({ python: opts.python as string, from: opts.from as string | undefined, signal: abort.signal, reporter: new Reporter() });
    if (opts.json || program.opts().json) await output({ type: 'setup', home: paths().root, ...result });
  });
program.command('doctor').description('Check media tools, model cache and inference device')
  .option('--json', 'print checks as JSON')
  .action(async opts => {
    const checks = await doctor(abort.signal);
    if (opts.json || program.opts().json) await output({ type: 'doctor', home: paths().root, checks });
    else {
      const reporter = new Reporter();
      reporter.note(`Home: ${paths().root}`);
      for (const check of checks) reporter.note(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}${check.fix ? `\n  ${check.fix}` : ''}`);
    }
    if (checks.some(check => !check.ok)) process.exitCode = 1;
  });
program.exitOverride();
try {
  await program.parseAsync();
} catch (error) {
  const code = (error as { code?: string }).code;
  if (code?.startsWith('commander.')) process.exitCode = (error as { exitCode: number }).exitCode;
  else if (brokenPipe) process.exitCode = 0;
  else {
    new Reporter().error(`✗ ${abort.signal.aborted ? message(abort.signal.reason) : message(error)}`);
    process.exitCode = abort.signal.aborted ? 130 : 1;
  }
}
