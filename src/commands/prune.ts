import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  expectedBaselines,
  orphanedBaselines,
  renameHints,
  walkBaselines,
} from '../baselines.ts';
import { formatBytes, loadConfig } from '../config.ts';
import { gitEnv, isGitRepo } from '../git.ts';
import { platformToken, resolveMatrix } from '../matrix.ts';
import { readStoryIndex } from '../story-index.ts';
import { displayPath } from '../paths.ts';

export interface PruneOptions {
  root: string;
  /** Delete the orphans instead of listing them. */
  yes?: boolean;
  /** Limit to one platform token's baselines, e.g. `linux-x64`. */
  platform?: string;
}

/** The path as the reader and git see it: relative to the project root, forward slashes. */
function shown(root: string, file: string): string {
  return displayPath(root, file);
}

/**
 * Delete the baseline set's dead weight: files no capture of the current matrix would
 * write, on the current platform token or any other one present. The default run only
 * lists them; `--yes` deletes and stages the deletions, so a prune reaches the commit the
 * same way an accept does.
 */
export async function pruneCommand(options: PruneOptions): Promise<number> {
  const { config } = await loadConfig(options.root);
  const storybookDir = path.resolve(options.root, config.storybookDir);
  const snapshotDir = path.resolve(options.root, config.snapshotDir);

  if (!existsSync(storybookDir)) {
    process.stderr.write(
      `No Storybook build at ${config.storybookDir} — prune reads the story index to know ` +
        'what to keep.\n',
    );
    return 1;
  }
  if (!existsSync(snapshotDir)) {
    process.stdout.write(`No baselines at ${config.snapshotDir} — nothing to prune.\n`);
    return 0;
  }

  const files = await walkBaselines(snapshotDir);

  // A symlink under the snapshot directory that resolves outside it would make everything
  // below read — and `--yes` delete — files the tool has no business touching. The real
  // location of every baseline is checked against the real directory up front, and one
  // escape refuses the whole prune rather than skipping just itself.
  const realRoot = realpathSync(snapshotDir);
  const escaping = files.filter((file) => {
    const real = realpathSync(file.absolute);
    return real !== realRoot && !real.startsWith(realRoot + path.sep);
  });
  if (escaping.length > 0) {
    process.stderr.write(
      `Refusing to prune — ${
        escaping.length === 1
          ? `a symlink under ${config.snapshotDir} resolves outside it`
          : `${escaping.length} symlinks under ${config.snapshotDir} resolve outside it`
      }:\n` +
        escaping.map((file) => `  ${shown(options.root, file.absolute)}`).join('\n') +
        '\n',
    );
    return 1;
  }

  const stories = await readStoryIndex(storybookDir);
  const matrix = resolveMatrix(stories, config);
  for (const warning of matrix.warnings) process.stderr.write(`warning: ${warning}\n`);

  // A repository keeps one baseline set per platform: the current token's, plus every other
  // one present on disk. A file is an orphan only when no platform's set would write it —
  // a story the index lost costs its baselines everywhere, a story it keeps costs none.
  const tokens = new Set([
    platformToken(),
    ...files.map((file) => file.platform).filter((token): token is string => Boolean(token)),
  ]);
  const expected = expectedBaselines(matrix.captures, tokens);
  const orphans = orphanedBaselines(files, expected).filter(
    (file) => options.platform === undefined || file.platform === options.platform,
  );

  if (orphans.length === 0) {
    process.stdout.write(
      `No orphaned baselines${options.platform ? ` for ${options.platform}` : ''}.\n`,
    );
    return 0;
  }

  const hints = await renameHints(
    orphans,
    snapshotDir,
    path.resolve(options.root, config.outputDir),
  );
  const bytes = orphans.reduce((total, file) => total + file.bytes, 0);

  const width = Math.max(...orphans.map((file) => shown(options.root, file.absolute).length));
  const lines = [
    `Diopsis prune · ${orphans.length} orphaned ${orphans.length === 1 ? 'baseline' : 'baselines'}, ` +
      `${formatBytes(bytes)}${options.yes ? '' : ' (dry run)'}`,
    ...(options.platform ? [`  platform  ${options.platform}`] : []),
    '',
  ];
  for (const orphan of orphans) {
    lines.push(
      `  ${shown(options.root, orphan.absolute).padEnd(width)}  ${formatBytes(orphan.bytes)}`,
    );
    const hint = hints.get(orphan.relative);
    if (hint) lines.push(`      looks renamed: ${hint.from} → ${hint.to}`);
  }
  lines.push('');

  if (!options.yes) {
    lines.push(`Would free ${formatBytes(bytes)} — re-run with --yes to delete.`, '');
    process.stdout.write(lines.join('\n'));
    return 0;
  }

  for (const orphan of orphans) await unlink(orphan.absolute);

  // Directories the deletions left empty go too, deepest first so a parent emptied by its
  // child is tried after the child. The snapshot directory itself stays: it is the
  // configured home of the set, and `doctor` expects to find it.
  const queue = [...new Set(orphans.map((file) => path.dirname(file.absolute)))]
    .filter((dir) => dir !== snapshotDir)
    .sort((a, b) => b.length - a.length);
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;
    try {
      await rmdir(dir);
    } catch {
      // Still holds baselines (or a stranger's file) — exactly what should remain.
      continue;
    }
    const parent = path.dirname(dir);
    if (parent !== snapshotDir && !queue.includes(parent)) queue.push(parent);
  }

  lines.push(
    `Deleted ${orphans.length} ${orphans.length === 1 ? 'baseline' : 'baselines'}, ` +
      `freed ${formatBytes(bytes)}.`,
  );

  if (!isGitRepo(options.root)) {
    lines.push('Not a git repository — the deletions are not staged.');
  } else {
    // `--cached` stages the deletion without touching the working tree; the tree is already
    // this command's own work. `--ignore-unmatch` keeps a path git never tracked from
    // failing the batch, so an untracked orphan deletes just as a tracked one does.
    const removed = spawnSync(
      'git',
      ['rm', '--quiet', '--cached', '--ignore-unmatch', '--', ...orphans.map((file) => shown(options.root, file.absolute))],
      { cwd: options.root, env: gitEnv, encoding: 'utf8' },
    );
    if (removed.status === 0) {
      lines.push('Staged the deletions — review, then commit.');
    } else {
      process.stdout.write(lines.join('\n') + '\n');
      process.stderr.write(
        'The files are deleted, but staging them failed:\n' +
          `${(removed.stderr || '').trim().split('\n').slice(0, 2).join('\n')}\n`,
      );
      return 1;
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
