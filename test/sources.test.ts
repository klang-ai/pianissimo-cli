import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFeed, probeFeed } from '../src/feeds.js';
import { discoverSources } from '../src/sources.js';
import { streamLines } from '../src/stream.js';
import { importModels } from '../src/state.js';
import { paths, REVISION } from '../src/config.js';
const signal = () => new AbortController().signal;
const feed = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Svenska &amp; röster</title>${items}</channel></rss>`;
const episode = (guid: string, url = '/episode.mp3') => `<item><title>Avsnitt åäö</title><guid>${guid}</guid><link>/episode</link><enclosure url="${url}" type="audio/mpeg"/></item>`;

test('RSS IDs survive signed URL changes; duplicate GUIDs and non-audio entries are skipped', () => {
  const first = [...parseFeed(feed(episode('123', '/episode.mp3?token=old') + episode('123') + '<item><title>No audio</title></item>'), 'https://pod.example/feed')];
  const next = [...parseFeed(feed(episode('123', '/episode.mp3?token=new')), 'https://pod.example/feed')];
  assert.equal(first.length, 1); assert.equal(first[0]!.id, next[0]!.id);
  assert.equal(first[0]!.mediaUrl, 'https://pod.example/episode.mp3?token=old');
  assert.equal(first[0]!.channel, 'Svenska & röster'); assert.equal(first[0]!.title, 'Avsnitt åäö');
  assert.equal(first[0]!.location, 'https://pod.example/episode');
});

test('Atom namespaces, GUID text and unsafe enclosures are handled explicitly', () => {
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><title>Podd</title><entry><id>urn:uuid:abc</id><title>Hej</title><link rel="alternate" href="/hello"/><link rel="enclosure" type="audio/ogg" href="/hello.ogg"/></entry></feed>';
  const items = [...parseFeed(atom, 'https://example.org/feed')];
  assert.equal(items.length, 1); assert.equal(items[0]!.mediaUrl, 'https://example.org/hello.ogg');
  assert.equal([...parseFeed(feed(episode('123').replace('<guid>123</guid>', '<guid isPermaLink="false">123</guid>')), 'https://example.org/feed')].length, 1);
  const warnings: string[] = [];
  assert.equal([...parseFeed(feed(episode('bad', 'file:///etc/passwd') + episode('ok')), 'https://example.org/feed', value => warnings.push(value))].length, 1);
  assert.equal(warnings.length, 1);
  assert.throws(() => [...parseFeed('<!DOCTYPE rss [<!ENTITY x "test">]><rss/>', 'https://example.org')], /entities/);
  assert.throws(() => [...parseFeed('<rss><channel>', 'https://example.org')], /Invalid podcast XML/);
  assert.throws(() => [...parseFeed('<html/>', 'https://example.org')], /not an RSS/);
});

test('feed probing detects generic XML, follows safe redirects, and limits bodies', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requested: string[] = [];
  globalThis.fetch = async input => {
    requested.push(String(input));
    return requested.length === 1 ? new Response(null, { status: 302, headers: { location: '/new-feed' } }) : new Response(feed(episode('one') + episode('two')), { headers: { 'Content-Type': 'text/plain' } });
  };
  const sources = [];
  for await (const source of discoverSources('https://pod.example/rss', { signal: signal(), limit: 1 })) sources.push(source);
  assert.equal(sources.length, 1); assert.equal(requested[1], 'https://pod.example/new-feed');
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } });
  await assert.rejects(probeFeed('https://pod.example/rss', signal()), /HTTP or HTTPS/);
  globalThis.fetch = async () => new Response(feed(episode('one')) + ' '.repeat(17 * 1024 * 1024), { headers: { 'Content-Type': 'application/rss+xml' } });
  await assert.rejects(probeFeed('https://pod.example/rss', signal()), /16 MiB/);
  globalThis.fetch = async () => new Response('Forbidden', { status: 403 });
  await assert.rejects(probeFeed('https://pod.example/rss', signal(), true), /HTTP 403/);
});

test('streaming discovery handles exits, cancellation and early return without orphan processes', async () => {
  const lines: string[] = [];
  for await (const line of streamLines(process.execPath, ['-e', 'console.log("åäö"); console.log("two")'], signal())) lines.push(line);
  assert.deepEqual(lines, ['åäö', 'two']);
  await assert.rejects(async () => { for await (const _ of streamLines('pianissimo-missing-command', [], signal())) {} }, /Cannot start/);
  await assert.rejects(async () => { for await (const _ of streamLines(process.execPath, ['-e', 'console.error("unavailable");process.exit(2)'], signal())) {} }, /unavailable/);
  for await (const line of streamLines(process.execPath, ['-e', 'console.log("one");setInterval(()=>console.log("more"),50)'], signal())) { assert.equal(line, 'one'); break; }
  const abort = new AbortController();
  const iterator = streamLines(process.execPath, ['-e', 'setInterval(()=>{},1000)'], abort.signal);
  const next = iterator.next(); abort.abort(); await assert.rejects(next);
});

test('model migration resolves HF snapshot symlinks and reuses bytes without touching the old home', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pianissimo-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = join(root, 'old'), home = paths(join(root, 'new'));
  const repo = 'models--KlangAI--pianissimo-sv';
  const snapshot = join(old, 'models', repo, 'snapshots', REVISION);
  const blob = join(old, 'models', repo, 'blobs', 'model');
  await mkdir(snapshot, { recursive: true }); await mkdir(join(old, 'models', repo, 'blobs'));
  await writeFile(blob, 'weights');
  await symlink('../../blobs/model', join(snapshot, 'pianissimo-sv.nemo'));
  assert.equal(await importModels(home, [old]), 1);
  assert.equal(await importModels(home, [old]), 0);
  const target = join(home.models, repo, 'snapshots', REVISION, 'pianissimo-sv.nemo');
  assert.equal((await lstat(target)).isSymbolicLink(), false);
  assert.equal((await stat(target)).ino, (await stat(blob)).ino);
  await rm(old, { recursive: true });
  assert.equal(await readFile(target, 'utf8'), 'weights');
});


test('CDATA descriptions do not count as nested XML; actual excessive nesting is rejected', () => {
  const description = '<description><![CDATA[' + '<br>'.repeat(200) + ']]></description>';
  assert.equal([...parseFeed(feed(episode('one').replace('</item>', description + '</item>')), 'https://pod.example/feed')].length, 1);
  const nested = '<rss>' + '<node>'.repeat(110) + '</node>'.repeat(110) + '</rss>';
  assert.throws(() => [...parseFeed(nested, 'https://pod.example/feed')], /nested tags/);
});

test('Atom inherits xml:base through the feed, entry, enclosure and alternate link', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://cdn.example/audio/">
    <entry xml:base="episodes/"><id>one</id><title>One</title>
      <link rel="enclosure" xml:base="clips/" href="one.mp3" type="audio/mpeg"/>
      <link rel="alternate" xml:base="https://pod.example/episodes/" href="one"/>
    </entry></feed>`;
  const [source] = [...parseFeed(atom, 'https://pod.example/feed')];
  assert.equal(source!.mediaUrl, 'https://cdn.example/audio/episodes/clips/one.mp3');
  assert.equal(source!.location, 'https://pod.example/episodes/one');
  const warnings: string[] = [];
  const invalid = atom.replace('xml:base="clips/"', 'xml:base="file:///private/"');
  assert.equal([...parseFeed(invalid, 'https://pod.example/feed', message => warnings.push(message))].length, 0);
  assert.equal(warnings.length, 1);
});

test('generic pages keep each embedded media resource and separate identical IDs across origins', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pianissimo-generic-'));
  const executable = join(root, 'yt-dlp');
  const previous = process.env.PIANISSIMO_YTDLP;
  t.after(async () => {
    if (previous === undefined) delete process.env.PIANISSIMO_YTDLP;
    else process.env.PIANISSIMO_YTDLP = previous;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(executable, `#!${process.execPath}
if(process.argv.includes('--version')) console.log('2026.08.19');
else {
  if(process.argv[process.argv.indexOf('-f')+1] !== 'bestaudio/best') throw new Error('Missing audio format selection');
  if(process.argv.at(-1).includes('missing')) console.log(JSON.stringify({id:'audio',extractor_key:'Generic',webpage_url:process.argv.at(-1),requested_formats:[{url:'https://cdn.example/video.mp4'},{url:'https://cdn.example/audio.mp3'}]}));
  else for (const name of ['a','b']) console.log(JSON.stringify({id:'audio',extractor_key:process.argv.at(-1).includes('html5')?'Html5MediaEmbed':'Generic',title:name,webpage_url:process.argv.at(-1),http_headers:{Referer:'https://one.example/original'},url:'https://cdn.example/'+name+'/audio.mp3'}));
}
`, { mode: 0o700 });
  process.env.PIANISSIMO_YTDLP = executable;
  const entries = [];
  for await (const source of discoverSources('https://one.example/page', { signal: signal(), sourceType: 'web' })) entries.push(source);
  assert.equal(entries.length, 2); assert.notEqual(entries[0]!.id, entries[1]!.id);
  assert.equal(entries[0]!.location, 'https://one.example/page');
  assert.equal(entries[0]!.mediaUrl, 'https://cdn.example/a/audio.mp3');
  assert.equal(entries[1]!.mediaUrl, 'https://cdn.example/b/audio.mp3');
  assert.equal(entries[0]!.referer, 'https://one.example/original');
  await assert.rejects(async () => {
    for await (const _ of discoverSources('https://one.example/missing', { signal: signal(), sourceType: 'web' })) {}
  }, /No unambiguous media URL/);
  const html5 = [];
  for await (const source of discoverSources('https://one.example/html5', { signal: signal(), sourceType: 'web' })) html5.push(source);
  assert.equal(html5.length, 2);
  assert.equal(html5[0]!.mediaUrl, 'https://cdn.example/a/audio.mp3');
  assert.equal(html5[0]!.referer, 'https://one.example/original');
  assert.notEqual(html5[0]!.id, html5[1]!.id);
  for await (const source of discoverSources('https://two.example/page', { signal: signal(), sourceType: 'web', limit: 1 })) assert.notEqual(source.id, entries[0]!.id);
});
