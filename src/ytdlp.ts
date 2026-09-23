import { ytdlpPath } from './config.js';
import { run } from './process.js';

export function isRecentYtdlp(version: string) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(version.trim());
  return Boolean(match && Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]) >= 20251112);
}
export async function checkYtdlp(signal: AbortSignal) {
  const version = await run(ytdlpPath(), ['--version'], { signal, timeoutMs: 15000 });
  if (!isRecentYtdlp(version)) throw new Error(`yt-dlp ${version} is too old. Run pianissimo setup to install the supported version.`);
  return version;
}
export function ytdlpArgs() {
  return ['--ignore-config', '--no-colors', '--js-runtimes', `node:${process.execPath}`, '--socket-timeout', '30'];
}
