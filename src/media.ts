import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './process.js';
import { ytdlpPath } from './config.js';
import { ytdlpArgs } from './ytdlp.js';
import type { Source } from './types.js';

export async function prepareAudio(source: Source, directory: string, signal: AbortSignal) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let input = source.location;
  if (source.kind !== 'file') {
    await run(ytdlpPath(), [...ytdlpArgs(), '--no-playlist', '--no-progress',
      ...(source.referer ? ['--referer', source.referer] : []),
      '--retries', '3', '--fragment-retries', '3', '--match-filter', '!is_live',
      '-f', 'bestaudio/best', '-o', join(directory, 'source.%(ext)s'), '--', source.mediaUrl ?? source.location], { signal });
    const downloaded = (await readdir(directory)).find(name => /^source\./.test(name) && !/\.(part|ytdl|temp)$/.test(name));
    if (!downloaded) throw new Error('No audio was downloaded. This video may be live or unavailable.');
    input = join(directory, downloaded);
  }
  const wav = join(directory, 'audio.wav');
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal });
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', wav], { signal });
  const duration = Number(raw);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The file contains no readable audio.');
  return { path: wav, duration, directory };
}
export async function sliceAudio(input: string, output: string, start: number, length: number, signal: AbortSignal) {
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', input,
    '-t', String(length), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output], { signal });
}
