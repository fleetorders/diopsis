import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../config.ts';
import { needsReview, type RunSummary } from '../report/summary.ts';

// Git exports GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR to hooks, absolute inside a linked
// worktree, and a child git prefers them over `cwd` — an inherited environment would make
// `git add` stage into whichever repository launched us, not `options.root`. Strip the
// whole prefix so `cwd` is the only authority on which repository we touch.
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

export interface AcceptOptions {
  root: string;
  /** Accept only this story. Omitted means the whole run. */
  storyId?: string;
  /** Skip staging the result in git. */
  noStage?: boolean;
}

/**
 * Adopt a run's output as the new baseline.
 *
 * Accepting is a file copy followed by a commit — there is no review state to keep anywhere
 * (DECISIONS.md §9), which is what makes the baseline set reviewable in the pull request
 * rather than in a service.
 */
export async function acceptCommand(options: AcceptOptions): Promise<number> {
  const { config } = await loadConfig(options.root);
  const outputDir = path.resolve(options.root, config.outputDir);
  const snapshotDir = path.resolve(options.root, config.snapshotDir);
  const summaryPath = path.join(outputDir, 'summary.json');

  let summary: RunSummary;
  try {
    summary = JSON.parse(await readFile(summaryPath, 'utf8')) as RunSummary;
  } catch {
    process.stderr.write(
      `No run to accept: ${path.relative(options.root, summaryPath)} is missing. ` +
        'Run `diopsis run` first, or unpack the run artifact from CI here.\n',
    );
    return 1;
  }

  const wanted = summary.captures.filter(
    (capture) =>
      needsReview(capture.status) &&
      capture.artifacts.actual &&
      (!options.storyId || capture.storyId === options.storyId),
  );

  if (wanted.length === 0) {
    process.stdout.write(
      options.storyId
        ? `Nothing to accept for ${options.storyId}.\n`
        : 'Nothing to accept — every capture already matched its baseline.\n',
    );
    return 0;
  }

  const written: string[] = [];
  for (const capture of wanted) {
    const from = path.resolve(outputDir, capture.artifacts.actual!);
    const to = path.join(snapshotDir, capture.snapshotPath);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    written.push(to);
  }

  process.stdout.write(
    `Accepted ${written.length} capture${written.length === 1 ? '' : 's'} ` +
      `into ${config.snapshotDir}.\n`,
  );

  if (!options.noStage) {
    const inRepo =
      spawnSync('git', ['rev-parse', '--git-dir'], {
        cwd: options.root,
        env: gitEnv,
        stdio: 'ignore',
      }).status === 0;

    if (!inRepo) {
      process.stdout.write('Not staged — this is not a git repository. The files are written.\n');
    } else {
      const staged = spawnSync('git', ['add', '--', ...written], {
        cwd: options.root,
        env: gitEnv,
        encoding: 'utf8',
      });
      process.stdout.write(
        staged.status === 0
          ? 'Staged. Review the diff, then commit.\n'
          : `Not staged — the files are written, but git refused to add them:\n` +
              `${(staged.stderr || '').trim().split('\n').slice(0, 2).join('\n')}\n`,
      );
    }
  }

  return 0;
}
