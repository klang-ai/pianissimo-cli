import { stat, readdir } from 'node:fs/promises';
import { basename, extname, resolve, join } from 'node:path';
import { digest, hashFile } from './util.js';
import { mediaUrl, probeFeed, parseFeed } from './feeds.js';
import { streamLines } from './stream.js';
import { checkYtdlp, ytdlpArgs } from './ytdlp.js';
import { ytdlpPath } from './config.js';
import type { DiscoveryOptions, Source } from './types.js';

const extensions = new Set('.wav .mp3 .mp4 .m4a .m4b .aac .flac .ogg .opus .aiff .aif .wma .webm .mkv .mov .avi .mpg .mpeg .caf .oga'.split(' '));
export async function* localEntries(input: string, recursive: boolean, signal: AbortSignal): AsyncGenerator<Source> {
  signal.throwIfAborted();
  const path = resolve(input), info = await stat(path);
  if (info.isFile()) {
    yield { id: `file:${digest(path)}`, kind: 'file', title: basename(path, extname(path)), location: path, fingerprint: await hashFile(path, signal) };
  } else if (info.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      signal.throwIfAborted();
      if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase()) || entry.isDirectory() && recursive) {
        yield* localEntries(join(path, entry.name), recursive, signal);
      }
    }
  } else throw new Error(`Not a regular file or directory: ${path}`);
}
// Retained for developer tools; the CLI itself consumes the iterator.
export async function localSources(input: string, recursive: boolean, signal: AbortSignal) {
  const result: Source[] = [];
  for await (const source of localEntries(input, recursive, signal)) result.push(source);
  return result;
}
export async function* webEntries(input: string, options: DiscoveryOptions): AsyncGenerator<Source> {
  await checkYtdlp(options.signal);
  const seen = new Set<string>();
  const args = [...ytdlpArgs(), '--flat-playlist', '--dump-json', '--skip-download', '--ignore-errors', '--lazy-playlist', '-f', 'bestaudio/best'];
  if (options.limit) args.push('--playlist-end', String(options.limit));
  args.push('--', input);
  for await (const line of streamLines(ytdlpPath(), args, options.signal)) {
    const item = JSON.parse(line) as Record<string, unknown>;
    if (item._type === 'playlist' || item.is_live === true || item.live_status === 'is_live' || item.live_status === 'is_upcoming') continue;
    const provider = String(item.extractor_key ?? item.ie_key ?? item.extractor ?? 'web').toLowerCase();
    const embedded = provider === 'generic' || provider === 'html5mediaembed';
    if (typeof item.id !== 'string' && !embedded) continue;
    const resource = typeof item.url === 'string' && /^https?:\/\//i.test(item.url) ? mediaUrl(item.url) : undefined;
    if (embedded && !resource) {
      throw new Error(`No unambiguous media URL for ${String(item.title ?? item.id ?? input)}. Run pianissimo setup to update the downloader.`);
    }
    // Generic IDs can just be basenames: /a/audio.mp3 and /b/audio.mp3 share one.
    const id = embedded ? `url:${digest(`${input}\0${resource}`)}` : `${provider}:${item.id}`;
    if (seen.has(id)) continue;
    const location = [item.webpage_url, item.url].find(value => typeof value === 'string' && /^https?:\/\//i.test(value));
    const url = typeof location === 'string' ? location : provider.startsWith('youtube') ? `https://www.youtube.com/watch?v=${encodeURIComponent(String(item.id))}` : undefined;
    if (!url) { options.onWarning?.(`Skipping ${item.id}: no playable URL was provided.`); continue; }
    seen.add(id);
    const headers = item.http_headers && typeof item.http_headers === 'object' ? item.http_headers as Record<string, unknown> : {};
    const headerReferer = Object.entries(headers).find(([name]) => name.toLowerCase() === 'referer')?.[1];
    yield { id, kind: 'url', provider, title: typeof item.title === 'string' ? item.title : String(item.id ?? url),
      location: mediaUrl(url), mediaUrl: embedded ? resource : undefined,
      referer: embedded ? mediaUrl(typeof headerReferer === 'string' ? headerReferer : url) : undefined,
      fingerprint: id, channel: typeof item.channel === 'string' ? item.channel : undefined,
      duration: typeof item.duration === 'number' ? item.duration : undefined,
      date: typeof item.upload_date === 'string' ? item.upload_date : undefined };
  }
}
export async function* discoverSources(input: string, options: DiscoveryOptions): AsyncGenerator<Source> {
  let sources: AsyncIterable<Source> | Iterable<Source>;
  if (/^https?:\/\//i.test(input)) {
    const url = mediaUrl(input);
    const host = new URL(url).hostname;
    let feed;
    const knownWeb = /(^|\.)(youtube\.com|youtu\.be|svtplay\.se|svt\.se|vimeo\.com)$/i.test(host);
    if (options.sourceType === 'feed' || options.sourceType !== 'web' && !knownWeb) {
      try { feed = await probeFeed(url, options.signal, options.sourceType === 'feed'); }
      catch (error) { options.signal.throwIfAborted(); if (options.sourceType === 'feed') throw error; }
    }
    if (options.sourceType === 'feed' && !feed) throw new Error('No RSS or Atom feed found at this URL.');
    sources = feed ? parseFeed(feed.xml, feed.url, options.onWarning) : webEntries(url, options);
  } else {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) throw new Error('Use a local path or an HTTP or HTTPS URL.');
    if (options.sourceType === 'feed' || options.sourceType === 'web') throw new Error('--source requires an HTTP or HTTPS URL.');
    sources = localEntries(input, options.recursive ?? false, options.signal);
  }
  let count = 0;
  for await (const source of sources) {
    options.signal.throwIfAborted();
    yield source;
    if (++count >= (options.limit ?? Infinity)) break;
  }
  if (!count) throw new Error('No playable audio found. For a podcast, use its RSS feed URL.');
}
