import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { digest } from './util.js';
import type { Source } from './types.js';

export function mediaUrl(value: string, base?: string) {
  let url: URL;
  try { url = new URL(value, base); } catch { throw new Error(`Invalid URL: ${value}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
  }
  url.hash = '';
  return url.href;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : typeof record(value)['#text'] === 'string' ? record(value)['#text'] as string : '';
const baseUrl = (node: Record<string, unknown>, parent: string): string => text(node['@_base']) ? mediaUrl(text(node['@_base']), parent) : parent;

export function* parseFeed(xml: string, feedUrl: string, warning: (text: string) => void = () => {}): Generator<Source> {
  if (Buffer.byteLength(xml) > 16 * 1024 * 1024) throw new Error('Podcast feed exceeds the 16 MiB limit.');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('Podcast feeds with document types or custom entities are not supported.');
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error(`Invalid podcast XML: ${valid.err.msg}`);
  const doc = record(new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, maxNestedTags: 100 }).parse(xml));
  const channel = record(record(doc.rss).channel);
  const atom = record(doc.feed);
  if (!doc.rss && !doc.feed) throw new Error('This URL is not an RSS or Atom feed. Use the podcast’s RSS feed URL.');
  const title = text(channel.title || atom.title).trim();
  const documentBase = doc.feed ? baseUrl(atom, feedUrl) : baseUrl(channel, baseUrl(record(doc.rss), feedUrl));
  const entries = array(channel.item ?? atom.entry);
  const seen = new Set<string>();
  for (const raw of entries) {
    const item = record(raw);
    const enclosures = [...array(item.enclosure), ...array(item.link).filter(v => record(v)['@_rel'] === 'enclosure')];
    const enclosure = enclosures.map(record).find(v => {
      const type = text(v['@_type']);
      return (!type || /^(audio|video)\//.test(type) || ['application/octet-stream', 'application/ogg'].includes(type)) && (v['@_url'] || v['@_href']);
    });
    if (!enclosure) continue;
    try {
      const entryBase = baseUrl(item, documentBase);
      const url = mediaUrl(text(enclosure['@_url'] ?? enclosure['@_href']), baseUrl(enclosure, entryBase));
      const guid = text(item.guid || item.id).trim() || url;
      const id = `feed:${digest(`${feedUrl}\0${guid}`)}`;
      if (seen.has(id)) continue;
      const alternate = array(item.link).map(record).find(v => !v['@_rel'] || v['@_rel'] === 'alternate') ?? {};
      const page = typeof item.link === 'string' ? item.link : text(alternate['@_href']);
      const location = page ? mediaUrl(page, baseUrl(alternate, entryBase)) : feedUrl;
      seen.add(id);
      yield { id, kind: 'feed', provider: 'podcast', fingerprint: id,
        title: text(item.title).trim() || title || 'Podcast episode', channel: title || undefined,
        location, mediaUrl: url,
        date: text(item.pubDate || item.published || item.updated) || undefined };
    } catch (error) { warning(`Skipping a podcast episode: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

// Probe only a bounded prefix for web pages; read full feeds with an explicit cap.
export async function probeFeed(input: string, signal: AbortSignal, required = false): Promise<{ xml: string; url: string } | undefined> {
  let url = mediaUrl(input);
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { signal: requestSignal, redirect: 'manual', headers: { 'User-Agent': 'pianissimo-cli/0.2', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new Error('Podcast URL has an invalid or excessive redirect chain.');
      url = mediaUrl(location, url); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`URL returned HTTP ${response.status}.`); }
    if (!response.body) throw new Error('The URL returned an empty response.');
    const type = response.headers.get('content-type') ?? '';
    if (!required && /^(audio|video)\//i.test(type)) { await response.body.cancel(); return; }
    const chunks: Buffer[] = []; let size = 0;
    let feed = required || /(?:rss|atom)\+xml/i.test(type);
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk); chunks.push(bytes); size += bytes.length;
      if (size > 16 * 1024 * 1024) throw new Error('Podcast feed exceeds the 16 MiB limit.');
      if (!feed) {
        const prefix = Buffer.concat(chunks).toString('utf8');
        feed = /<(?:\w+:)?(?:rss|feed)(?:\s|>)/i.test(prefix);
        if (!feed && (size >= 65536 || /<(?:!doctype\s+html|html)(?:\s|>)/i.test(prefix))) return;
      }
    }
    if (!feed) return;
    return { xml: Buffer.concat(chunks).toString('utf8'), url };
  }
}
