import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ACCEPTED_A11Y_FILENAME,
  adoptFindings,
  formatAcceptedA11y,
  readAcceptedA11y,
  type AcceptedAccessibility,
} from '../accessibility.ts';
import { recompressBaselines, writeRecompressReport } from '../compress.ts';
import { loadConfig } from '../config.ts';
import { gitEnv, isGitRepo } from '../git.ts';
import { needsReview, type CaptureResult, type RunSummary } from '../report/summary.ts';
import { displayPath } from '../paths.ts';

export interface AcceptOptions {
  root: string;
  /** Accept only these stories. Omitted means the whole run. */
  storyIds?: string[];
  /** Directory of the run to accept from — a merged run, or any downloaded one. */
  from?: string;
  /** Skip staging the result in git. */
  noStage?: boolean;
}

/**
 * A path under `base`, resolved — or undefined when the path escapes it. The summary may
 * come from a downloaded run artifact, so every path it carries is data about the run
 * rather than a path to follow: an `artifacts.actual` that climbs out of the output
 * directory, or a `snapshotPath` that climbs out of the snapshot directory, must not turn
 * the accept into a copy or a write outside the run.
 */
function containedPath(base: string, relative: string): string | undefined {
  const resolved = path.resolve(base, relative);
  const within = path.relative(base, resolved);
  return within === '' || within.startsWith('..') || path.isAbsolute(within)
    ? undefined
    : resolved;
}

/**
 * Adopt a run's output as the new baseline.
 *
 * Accepting is a file copy followed by a commit — there is no review state to keep anywhere
 * (docs/decisions.md, D-048), which is what makes the baseline set reviewable in the pull request
 * rather than in a service.
 */
export async function acceptCommand(options: AcceptOptions): Promise<number> {
  const { config } = await loadConfig(options.root);
  // A merged run, or a downloaded one, is accepted from where its summary sits; the
  // configured output directory is only the default.
  const outputDir = path.resolve(options.root, options.from ?? config.outputDir);
  // The directory as the user named it — an escape message must point at where the run was
  // actually read from, which --from moves away from the configured output directory.
  const readFrom = options.from ?? config.outputDir;
  const snapshotDir = path.resolve(options.root, config.snapshotDir);
  const summaryPath = path.join(outputDir, 'summary.json');

  let summary: RunSummary;
  try {
    summary = JSON.parse(await readFile(summaryPath, 'utf8')) as RunSummary;
  } catch {
    process.stderr.write(
      `No run to accept: ${displayPath(options.root, summaryPath)} is missing. ` +
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
  // A candidate that carries audit data failed on findings, not pixels — the comparison
  // passed, there is no image to copy, and its findings are what this accept adopts. Only
  // a capture with nothing adoptable about it is reported as skipped.
  const skipped = candidates.filter(
    (capture) => !adoptable(capture) && !capture.accessibility,
  );

  // The audit's findings are adopted beside the images, for the same stories the accept
  // covers. A summary from a run that never audited has no accessibility data anywhere,
  // and such an accept leaves the accepted-findings file untouched.
  const acceptedPath = path.join(snapshotDir, ACCEPTED_A11Y_FILENAME);
  let acceptedExisting: AcceptedAccessibility = {};
  let acceptedText = '';
  if (summary.captures.some((capture) => capture.accessibility)) {
    // An absent file is a first accept; an unreadable one is refused, because rebuilding
    // it from nothing would drop every other story's accepted findings in the rewrite.
    try {
      acceptedExisting = await readAcceptedA11y(acceptedPath);
      if (existsSync(acceptedPath)) acceptedText = await readFile(acceptedPath, 'utf8');
    } catch (error) {
      process.stderr.write(
        `Cannot accept — ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }
  const adopted = adoptFindings(acceptedExisting, summary.captures, inScope);

  if (candidates.length === 0 && !adopted) {
    process.stdout.write(
      wantedIds.length > 0
        ? `Nothing to accept for ${wantedIds.join(', ')}.\n`
        : 'Nothing to accept — every capture already matched its baseline.\n',
    );
    return reportUnknownIds(unknownIds);
  }

  // Every source and destination is resolved and contained before anything is copied: a
  // summary naming a path outside the run or the snapshot directory refuses the whole
  // accept — nothing is copied at all — with the entry that escaped named.
  // A merged run's images stay in the shard directories it was merged from, wherever those
  // were, so each image is contained by one of them. Only a directory named like a shard
  // counts: the list is data from the summary, and must not widen the base to anything.
  const merged = summary.acceptFrom !== undefined && summary.shard === undefined;
  const runBases = merged
    ? (Array.isArray(summary.shardDirs) ? summary.shardDirs : [])
        .filter((dir): dir is string => typeof dir === 'string')
        .map((dir) => path.resolve(outputDir, dir))
        .filter((dir) => /^shard-\d+-of-\d+$/.test(path.basename(dir)))
    : [outputDir];
  const copies: Array<{ from: string; to: string }> = [];
  const escapes: string[] = [];
  for (const capture of wanted) {
    const actual = path.resolve(outputDir, capture.artifacts.actual!);
    const from = runBases
      .map((base) => containedPath(base, path.relative(base, actual)))
      .find((contained) => contained !== undefined);
    const to = containedPath(snapshotDir, capture.snapshotPath);
    if (from !== undefined && to !== undefined) {
      copies.push({ from, to });
      continue;
    }
    if (from === undefined) {
      escapes.push(
        `${capture.storyId}: run image "${capture.artifacts.actual}" is not inside ` +
          (merged ? `a shard directory ${readFrom} was merged from` : readFrom),
      );
    }
    if (to === undefined) {
      escapes.push(
        `${capture.storyId}: baseline path "${capture.snapshotPath}" is not inside ${config.snapshotDir}`,
      );
    }
  }
  if (escapes.length > 0) {
    process.stderr.write(
      'Cannot accept — the summary names a path outside where it belongs:\n' +
        escapes.map((line) => `  ${line}`).join('\n') +
        '\nNothing was copied.\n',
    );
    return 1;
  }

  // Nothing is copied until every source is known to exist: a partial accept out of an
  // incomplete run artifact would leave the baseline set half-updated.
  const missing = copies.map((copy) => copy.from).filter((from) => !existsSync(from));
  if (missing.length > 0) {
    process.stderr.write(
      `Cannot accept — ${missing.length} run ${missing.length === 1 ? 'image is' : 'images are'} missing:\n` +
        // Forward slashes on every platform: the list is read, pasted and compared against
        // the artifact's contents, which never depend on the machine that printed it.
        missing
          .map((from) => `  ${displayPath(options.root, from)}`)
          .join('\n') +
        `\nA run artifact must include its test-results images.\n`,
    );
    return 1;
  }

  const written: string[] = [];
  for (const { from, to } of copies) {
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    written.push(to);
  }

  // The accepted-findings file is written only when adopting changed it — a re-accept of
  // the same run rewrites identical content, and a needless rewrite is a needless diff.
  let findingsWritten = false;
  if (adopted) {
    const formatted = formatAcceptedA11y(adopted.next);
    if (formatted !== acceptedText) {
      await mkdir(path.dirname(acceptedPath), { recursive: true });
      await writeFile(acceptedPath, formatted, 'utf8');
      findingsWritten = true;
    }
  }

  for (const capture of skipped) {
    process.stdout.write(
      `  skipped ${capture.storyId} @${capture.width}` +
        `${capture.mode ? ` [${capture.mode}]` : ''}` +
        `${capture.state ? ` {${capture.state}}` : ''}: ${capture.status}\n`,
    );
  }

  if (written.length > 0) {
    process.stdout.write(
      `Accepted ${written.length} capture${written.length === 1 ? '' : 's'} ` +
        `into ${config.snapshotDir}.\n`,
    );
  }
  if (findingsWritten) {
    const file = `${config.snapshotDir}${config.snapshotDir.endsWith('/') ? '' : '/'}${ACCEPTED_A11Y_FILENAME}`;
    if (adopted!.stories > 0) {
      process.stdout.write(
        `Accepted accessibility findings for ${adopted!.stories} ` +
          `${adopted!.stories === 1 ? 'story' : 'stories'} into ${file}.\n`,
      );
    } else {
      // The only change the adoption made was removals: the run stopped reporting
      // findings the file still claimed.
      process.stdout.write(
        `Dropped accepted accessibility findings the run no longer reports, in ${file}.\n`,
      );
    }
  }
  if (written.length === 0 && !findingsWritten) {
    process.stdout.write('Nothing to accept — no reviewable capture produced an image.\n');
  }

  if (config.compress === 'auto' && written.length > 0) {
    // Recompression happens before the staging below, so what git is handed is the
    // smallest form of the same pixels rather than a second change to review.
    writeRecompressReport(await recompressBaselines({ files: written, root: options.root }));
  }

  const stagedPaths = findingsWritten ? [...written, acceptedPath] : written;
  if (!options.noStage && stagedPaths.length > 0) {
    const inRepo = isGitRepo(options.root);

    if (!inRepo) {
      process.stdout.write('Not staged — this is not a git repository. The files are written.\n');
    } else {
      const staged = spawnSync('git', ['add', '--', ...stagedPaths], {
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
