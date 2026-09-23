export type Format = 'txt' | 'md' | 'json' | 'srt' | 'vtt';
export type Device = 'auto' | 'cpu' | 'cuda' | 'mps';
export interface Runtime { device: Exclude<Device, 'auto'>; deviceName?: string; torch?: string; nemo?: string }
export interface Source {
  id: string;
  kind: 'file' | 'url' | 'feed';
  title: string;
  location: string;
  fingerprint: string;
  mediaUrl?: string;
  referer?: string;
  provider?: string;
  duration?: number;
  channel?: string;
  date?: string;
}
export interface Settings {
  model: string;
  revision: string;
  device: Device;
  chunkSeconds: number;
  pipelineVersion: number;
}
export interface Word { start: number; end: number; text: string }
export interface Recognition { text: string; words: Word[] }
export interface Transcript extends Recognition {
  schemaVersion: 1;
  source: Source;
  model: { id: string; revision: string; license: string };
  settings: Settings;
  duration: number;
  createdAt: string;
  processingSeconds: number;
  runtime?: Runtime;
}
export interface RunOptions {
  output: string;
  formats: Format[];
  settings: Settings;
  downloads: number;
  keepAudio: boolean;
  force: boolean;
}
export interface DiscoveryOptions { signal: AbortSignal; recursive?: boolean; limit?: number; sourceType?: 'auto' | 'feed' | 'web'; onWarning?: (message: string) => void }
export interface Engine {
  readonly runtime?: Runtime;
  transcribe(path: string, signal: AbortSignal): Promise<Recognition>;
  close(): Promise<void>;
}
