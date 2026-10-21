import path from 'node:path';

/**
 * A path as Diopsis prints it and records it: relative to `from`, with forward slashes on
 * every platform. Output is pasted into reviews and `summary.json` travels between machines,
 * so neither may depend on the separator of the machine that wrote it. `impl` exists so the
 * Windows behaviour can be tested on any machine.
 */
export function displayPath(from: string, to: string, impl: typeof path = path): string {
  const relative = impl.relative(from, to);
  return (relative || to).split(impl.sep).join('/');
}

