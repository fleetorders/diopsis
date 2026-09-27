import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { formatBytes } from './config.ts';
import { decodePng } from './png.ts';
import { displayPath } from './paths.ts';

/**
 * Lossless baseline recompression (DECISIONS.md D-043).
 *
 * Every baseline `update` and `accept` writes is encoded by the browser's PNG encoder,
 * which leaves room on the table. With `compress: 'auto'`, each written baseline is handed
 * to the `oxipng` executable — never a dependency, only an executable that may or may not
 * be on the machine — and kept only after this module's own decoder proves the pixels
 * survived. The tool's alpha optimisation is never asked for: it is the one mode that
 * changes pixels rather than bytes.
 */

/** Files per invocation: a bound on argv length and on the originals held for one batch. */
const BATCH_SIZE = 100;

/**
 * The executable to run. `DIOPSIS_OXIPNG` names it explicitly — a specific build, a
 * vendor directory — and the default is whatever the PATH resolves, so recompression is
 * a question about the machine rather than another setting to keep true across it.
 */
function executableName(env: NodeJS.ProcessEnv = process.env): string {
  return env.DIOPSIS_OXIPNG ?? 'oxipng';
}

/** Whether the recompressor is installed, as its own `--version` run answers it. */
export function oxipngInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const probe = spawnSync(executableName(env), ['--version'], { stdio: 'ignore', timeout: 10_000 });
  return probe.status === 0;
}

/** Longest one batch may take — far past any normal batch, short of a hang. */
const TOOL_TIMEOUT_MS = 5 * 60_000;

/** One invocation: spawned directly, never through a shell, so a file name is an argument and nothing else. */
function runTool(executable: string, args: string[]): Promise<{ code: number | null; detail: string }> {
  return new Promise((resolve) => {
    // A batch that hangs is failed and killed, like one that errors: the baselines it held
    // are left as they were, and update or accept still finishes.
    const child = spawn(executable, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: TOOL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => resolve({ code: null, detail: error.message }));
    child.on('close', (code, signal) =>
      resolve({
        code,
        detail: signal
          ? `stopped by ${signal} (limit ${TOOL_TIMEOUT_MS / 60_000} minutes)`
          : (stderr.trim().split('\n')[0] ?? ''),
      }),
    );
  });
}

export type RecompressOutcome =
  | { kind: 'missing' }
  | {
      kind: 'done';
      /** Baselines whose recompressed bytes were kept. */
      compressed: number;
      /** Total bytes before recompression — restored and failed files included. */
      bytesBefore: number;
      /** Total bytes after: kept files recompressed, everything else exactly as it was. */
      bytesAfter: number;
      /** Baselines whose recompression was not pixel-identical and was put back, relative to `root`. */
      restored: string[];
      /** One entry per batch the tool itself failed on, which was left as it was. */
      failedBatches: string[];
    };

/** `root`-relative with forward slashes — the one way a path is shown anywhere in the output. */
function shown(root: string, file: string): string {
  return displayPath(root, file);
}

/**
 * Whether two PNG byte streams decode to the same RGBA — the comparison that makes
 * "lossless" a checked guarantee rather than the tool's word. A file that cannot be
 * decoded at all counts as a difference: it is not provably the same image.
 */
function samePixels(one: Uint8Array, two: Uint8Array): boolean {
  let before;
  let after;
  try {
    before = decodePng(one);
    after = decodePng(two);
  } catch {
    return false;
  }
  if (before.width !== after.width || before.height !== after.height) return false;
  if (before.rgba.length !== after.rgba.length) return false;
  for (let at = 0; at < before.rgba.length; at++) {
    if (before.rgba[at] !== after.rgba[at]) return false;
  }
  return true;
}

/**
 * Recompress freshly written baselines in place. The tool rewrites files in place, so each
 * batch's original bytes are read before it runs — they are both the pixel comparison's
 * reference and the bytes a restore puts back. Nothing here can fail the run: a missing
 * tool is only reported, a failed batch is left as it was, a changed-pixel file is
 * restored, and the baselines stand either way.
 */
export async function recompressBaselines(input: {
  /** Absolute paths of the baselines just written. */
  files: string[];
  /** Warnings name files relative to this directory. */
  root: string;
}): Promise<RecompressOutcome> {
  const report = {
    compressed: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    restored: [] as string[],
    failedBatches: [] as string[],
  };
  if (input.files.length === 0) return { kind: 'done', ...report };

  const executable = executableName();
  if (!oxipngInstalled()) return { kind: 'missing' };

  for (let at = 0; at < input.files.length; at += BATCH_SIZE) {
    const batch = input.files.slice(at, at + BATCH_SIZE);
    const originals = new Map<string, Uint8Array>();
    for (const file of batch) {
      try {
        originals.set(file, await readFile(file));
      } catch {
        // A baseline that cannot be read was never written; the tool would only fail on it.
      }
    }
    const runnable = batch.filter((file) => originals.has(file));
    if (runnable.length === 0) continue;

    const result = await runTool(executable, ['-o', '4', '--strip', 'safe', '--quiet', ...runnable]);
    for (const file of runnable) {
      const original = originals.get(file)!;
      report.bytesBefore += original.length;
      let recompressed: Uint8Array | undefined;
      try {
        recompressed = await readFile(file);
      } catch {
        // Without the recompressed bytes there is nothing to verify; restore below.
      }
      if (result.code === 0 && recompressed !== undefined && samePixels(original, recompressed)) {
        report.compressed += 1;
        report.bytesAfter += recompressed.length;
      } else {
        await writeFile(file, original);
        report.bytesAfter += original.length;
        if (result.code === 0) report.restored.push(shown(input.root, file));
      }
    }
    if (result.code !== 0) {
      report.failedBatches.push(
        `${runnable.length} ${runnable.length === 1 ? 'baseline' : 'baselines'}` +
          (result.detail ? ` — ${result.detail}` : ` — exit code ${result.code ?? 'none'}`),
      );
    }
  }
  return { kind: 'done', ...report };
}

/**
 * What recompression says for itself: the one line a missing tool earns, the totals a run
 * of it earns, and a warning per file put back. None of it is an error — none of it can
 * fail the run — so the totals go to stdout and the rest warns.
 */
export function writeRecompressReport(outcome: RecompressOutcome): void {
  if (outcome.kind === 'missing') {
    process.stderr.write(
      'compress is auto, but oxipng is not installed — baselines are written uncompressed ' +
        '(see https://github.com/oxipng/oxipng)\n',
    );
    return;
  }
  if (outcome.compressed + outcome.restored.length + outcome.failedBatches.length === 0) return;

  if (outcome.compressed > 0) {
    const saved = outcome.bytesBefore - outcome.bytesAfter;
    process.stdout.write(
      `Recompressed ${outcome.compressed} ` +
        `${outcome.compressed === 1 ? 'baseline' : 'baselines'} with oxipng` +
        (saved > 0 ? ` — ${formatBytes(outcome.bytesBefore)} → ${formatBytes(outcome.bytesAfter)}` : '') +
        '\n',
    );
  }
  for (const file of outcome.restored) {
    process.stderr.write(
      `warning: recompression was not lossless for ${file} — the original baseline was restored\n`,
    );
  }
  for (const batch of outcome.failedBatches) {
    process.stderr.write(`warning: oxipng failed on ${batch} — the originals were kept\n`);
  }
}
