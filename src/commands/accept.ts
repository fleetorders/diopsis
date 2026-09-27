import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../config.ts';
import { gitEnv, isGitRepo } from '../git.ts';
import { needsReview, type CaptureResult, type RunSummary } from '../report/summary.ts';

export interface AcceptOptions {
  root: string;
  /** Accept only these stories. Omitted means the whole run. */
  storyIds?: string[];
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

  // An id that names no story at all is a typo about to look like success. The rest of the
  // accept still happens; the typo alone turns the exit code non-zero.
  const wantedIds = options.storyIds ?? [];
  const unknownIds = wantedIds.filter(
    (id) => !summary.captures.some((capture) => capture.storyId === id),
  );
  const inScope = (storyId: string) => wantedIds.length === 0 || wantedIds.includes(storyId);

  // Only a capture that produced an image can be adopted: a story that failed to render
  // or to compare has no output worth keeping, and copying it would write a broken
  // baseline while looking like progress.
  const adoptable = (capture: CaptureResult): boolean =>
    (capture.status === 'changed' || capture.status === 'new') && Boolean(capture.artifacts.actual);

  const candidates = summary.captures.filter(
    (capture) => inScope(capture.storyId) && needsReview(capture.status),
  );
  const wanted = candidates.filter(adoptable);
  const skipped = candidates.filter((capture) => !adoptable(capture));

  if (candidates.length === 0) {
    process.stdout.write(
      wantedIds.length > 0
        ? `Nothing to accept for ${wantedIds.join(', ')}.\n`
        : 'Nothing to accept — every capture already matched its baseline.\n',
    );
    return reportUnknownIds(unknownIds);
  }

  // Nothing is copied until every source is known to exist: a partial accept out of an
  // incomplete run artifact would leave the baseline set half-updated.
  const missing = wanted
    .map((capture) => path.resolve(outputDir, capture.artifacts.actual!))
    .filter((from) => !existsSync(from));
  if (missing.length > 0) {
    process.stderr.write(
      `Cannot accept — ${missing.length} run ${missing.length === 1 ? 'image is' : 'images are'} missing:\n` +
        // Forward slashes on every platform: the list is read, pasted and compared against
        // the artifact's contents, which never depend on the machine that printed it.
        missing
          .map((from) => `  ${path.relative(options.root, from).split(path.sep).join('/')}`)
          .join('\n') +
        `\nA run artifact must include ${config.outputDir}/test-results.\n`,
    );
    return 1;
  }

  const written: string[] = [];
  for (const capture of wanted) {
    const from = path.resolve(outputDir, capture.artifacts.actual!);
    const to = path.join(snapshotDir, capture.snapshotPath);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    written.push(to);
  }

  for (const capture of skipped) {
    process.stdout.write(
      `  skipped ${capture.storyId} @${capture.width}` +
        `${capture.mode ? ` [${capture.mode}]` : ''}` +
        `${capture.state ? ` {${capture.state}}` : ''}: ${capture.status}\n`,
    );
  }

  process.stdout.write(
    written.length > 0
      ? `Accepted ${written.length} capture${written.length === 1 ? '' : 's'} ` +
          `into ${config.snapshotDir}.\n`
      : 'Nothing to accept — no reviewable capture produced an image.\n',
  );

  if (!options.noStage && written.length > 0) {
    const inRepo = isGitRepo(options.root);

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

  return reportUnknownIds(unknownIds);
}

function reportUnknownIds(unknownIds: string[]): number {
  for (const id of unknownIds) {
    process.stderr.write(`No story "${id}" in the last run's summary.\n`);
  }
  return unknownIds.length > 0 ? 1 : 0;
}
