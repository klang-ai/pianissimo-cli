import { spawn, type ChildProcess } from 'node:child_process';

// Each owned POSIX subprocess gets a process group. Stopping just yt-dlp/uv can
// otherwise leave ffmpeg or installers alive, sometimes holding our pipes open.
export const subprocessOptions = { detached: process.platform !== 'win32', windowsHide: true };

export function lifecycle(child: ChildProcess, graceMs = 3000) {
  let stopping = false;
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  let killer: ChildProcess | undefined;
  const signalTree = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      // Windows does not implement POSIX process groups. /T includes descendants.
      if (!killer) {
        killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => { child.kill('SIGKILL'); });
      }
    } else {
      try { process.kill(-child.pid, signal); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
      }
    }
  };
  const stop = () => {
    if (stopping || finished) return;
    stopping = true;
    signalTree('SIGTERM');
    timer = setTimeout(() => signalTree('SIGKILL'), graceMs);
    timer.unref();
  };
  const closed = new Promise<void>(resolve => {
    child.once('close', () => {
      // A detached descendant may close its pipes but still run. Reap the group
      // even when the leader exits before the grace timer expires.
      if (stopping) signalTree('SIGKILL');
      finished = true;
      clearTimeout(timer);
      if (killer && killer.exitCode === null && killer.signalCode === null) killer.once('close', () => resolve());
      else resolve();
    });
  });
  return { stop, closed };
}
