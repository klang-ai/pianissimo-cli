import { join } from 'node:path';
import { atomicWrite, sourceStem } from './util.js';
import type { Format, Transcript, Word } from './types.js';

export interface Cue { start: number; end: number; text: string }
export function cues(words: Word[]): Cue[] {
  const result: Cue[] = [];
  let group: Word[] = [];
  const flush = () => {
    if (!group.length) return;
    const lines: string[] = [''];
    for (const word of group) {
      let i = lines.length - 1;
      if (lines[i] && lines[i]!.length + word.text.length + 1 > 42) { lines.push(''); i++; }
      lines[i] += (lines[i] ? ' ' : '') + word.text;
    }
    result.push({ start: group[0]!.start, end: Math.max(group.at(-1)!.end, group[0]!.start + 0.01), text: lines.join('\n') });
    group = [];
  };
  for (const word of words) {
    if (group.length) {
      const previous = group.at(-1)!;
      const combined = group.map(w => w.text).join(' ') + ' ' + word.text;
      const wrapped: string[] = [''];
      for (const token of combined.split(/\s+/)) {
        let i = wrapped.length - 1;
        if (wrapped[i] && wrapped[i]!.length + token.length + 1 > 42) { wrapped.push(''); i++; }
        wrapped[i] += (wrapped[i] ? ' ' : '') + token;
      }
      if (word.end - group[0]!.start > 6 || word.start - previous.end > 0.8 || wrapped.length > 2) flush();
    }
    group.push(word);
    if (/[.!?…][”"')\]]?$/.test(word.text)) flush();
  }
  flush();
  return result;
}
export function timestamp(seconds: number, separator = '.') {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}
export function render(transcript: Transcript, format: Format): string {
  if (format === 'json') return JSON.stringify(transcript, null, 2) + '\n';
  if (format === 'txt') return transcript.text + '\n';
  if (format === 'md') {
    const title = transcript.source.title.replace(/[\r\n]/g, ' ').replace(/[\\`*_{}\[\]<>#]/g, '\\$&');
    return `# ${title}\n\nSource: ${transcript.source.location.replace(/[\r\n]/g, '')}\n\nModel: ${transcript.model.id} (${transcript.model.revision})\n\n${transcript.text}\n`;
  }
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const content = cues(transcript.words).map((cue, i) => {
    const separator = format === 'srt' ? ',' : '.';
    return `${format === 'srt' ? `${i + 1}\n` : ''}${timestamp(cue.start, separator)} --> ${timestamp(cue.end, separator)}\n${escape(cue.text)}\n`;
  }).join('\n');
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + content;
}
export function exportStem(source: Transcript['source'], key: string) { return `${sourceStem(source)}--${key.slice(0, 8)}`; }
export async function exportTranscript(transcript: Transcript, output: string, formats: Format[], key: string) {
  const stem = exportStem(transcript.source, key);
  const files: string[] = [];
  // Always retain the canonical transcript, source, timestamps and model provenance.
  for (const format of new Set<Format>(['json', ...formats])) {
    const path = join(output, `${stem}.${format}`);
    await atomicWrite(path, render(transcript, format));
    files.push(path);
  }
  return files;
}
