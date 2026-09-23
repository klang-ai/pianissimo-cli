import pc from 'picocolors';
import { cleanTerminal, duration } from './util.js';

export class Reporter {
  private current = '';
  private started = Date.now();
  private ticker?: NodeJS.Timeout;
  private frame = 0;
  private interactive: boolean;
  constructor(private quiet = false) { this.interactive = Boolean(process.stderr.isTTY && !process.env.CI && !quiet); }
  start(label = 'Transcribing') {
    this.started = Date.now();
    this.note(`pianissimo  ·  ${label}`);
    if (this.interactive) {
      this.ticker = setInterval(() => this.draw(), 100);
      this.ticker.unref();
    }
  }
  status(text: string) {
    this.current = cleanTerminal(text);
    if (!this.interactive) this.note(text);
  }
  note(text: string) {
    if (this.quiet) return;
    this.error(text);
  }
  error(text: string) {
    this.clear();
    const clean = text.split('\n').map(cleanTerminal).join('\n');
    const colored = clean.startsWith('✓') ? pc.green('✓') + clean.slice(1) : clean.startsWith('✗') ? pc.red('✗') + clean.slice(1) : clean;
    process.stderr.write(colored + '\n');
  }
  private clear() { if (this.interactive) process.stderr.write('\r\x1b[2K'); }
  private draw() {
    if (!this.current) return;
    this.clear();
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const width = Math.max(20, (process.stderr.columns || 80) - 16);
    process.stderr.write(`${pc.cyan(frames[this.frame++ % frames.length]!)} ${this.current.slice(0, width)} ${pc.dim(duration((Date.now() - this.started) / 1000))}`);
  }
  finish(text: string) { clearInterval(this.ticker); this.clear(); this.current = ''; this.note(text); }
}
