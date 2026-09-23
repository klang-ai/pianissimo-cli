import { fileURLToPath } from 'node:url';
// Keep development state and model downloads inside this checkout.
process.env.PIANISSIMO_HOME ??= fileURLToPath(new URL('../.pianissimo', import.meta.url));
await import('../src/cli.js');
