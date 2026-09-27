import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../config.ts';
import { comparePng } from '../compare.ts';
import { gitEnv, isGitRepo } from '../git.ts';
import { parseSnapshotPath, type ParsedSnapshotPath } from '../matrix.ts';
import { decodePng, pngSize } from '../png.ts';
import { findRegions } from '../regions.ts';
import { renderReport } from '../report/html.ts';
import {
  changedStoriesOf,
  totalsFor,
  type CaptureResult,
  type RunSummary,
} from '../report/summary.ts';
import { openWithDesktop } from './report.ts';

export interface DiffOptions {
  root: string;
  /** The ref to diff against. Default: `origin/main`, falling back to `main`. */
  base?: string;
  /** Limit to one platform token's baselines, e.g. `linux-x64`. Default: every platform. */
  platform?: string;
  /** Open the report after writing it, like `diopsis report` does. */
  open?: boolean;
}

/** One baseline path git reported as changed between the merge base and the working tree. */
interface BaselineChange {
  /** Relative to the snapshot directory, with the forward slashes git reports. */
  path: string;
  kind: 'modified' | 'added' | 'deleted';
}

/** Everything an entry needs to be read, compared and written. */
interface DiffContext {
  root: string;
  mergeBase: string;
  snapshotDir: string;
  snapshotAbs: string;
  diffDir: string;
  /** The project's own per-pixel tolerance — the same knob a run compares with. */
  threshold: number;
}

/** Regions kept per changed capture, matching the run reporter's cap. */
const MAX_REGIONS = 20;

/** Baseline PNGs run to megabytes; spawnSync's 1 MiB default would truncate them. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

function gitBytes(
  root: string,
  args: string[],
): { status: number | null; stdout: Buffer; stderr: string } {
  const run = spawnSync('git', args, { cwd: root, env: gitEnv, maxBuffer: GIT_MAX_BUFFER });
  return {
    status: run.status,
    stdout: Buffer.from(run.stdout ?? []),
    stderr: (run.stderr ?? Buffer.alloc(0)).toString('utf8'),
  };
}

function refExists(root: string, ref: string): boolean {
  return gitBytes(root, ['rev-parse', '--verify', '--quiet', ref]).status === 0;
}

/**
 * Display names without a Storybook build. The diff reads only the baseline history, so
 * the title and name come out of the id by Storybook's own convention: everything before
 * the first `--` names the component, everything after it the story.
 */
function storyNames(storyId: string): { storyTitle: string; storyName: string } {
  const split = storyId.indexOf('--');
  return split === -1
    ? { storyTitle: storyId, storyName: storyId }
    : { storyTitle: storyId.slice(0, split), storyName: storyId.slice(split + 2) };
}

/**
 * Baseline paths that differ between the merge base and the working tree — committed or
 * not. `git diff` covers the tracked side; untracked files under the snapshot directory
 * are baselines this branch is about to add, so they join as additions.
 */
function baselineChanges(root: string, snapshotDir: string, mergeBase: string): BaselineChange[] {
  const changes: BaselineChange[] = [];
  const prefix = `${snapshotDir}/`;
  const inside = (file: string): string =>
    file.startsWith(prefix) ? file.slice(prefix.length) : file;

  // `--relative` makes the reported paths relative to this directory rather than the
  // repository root, so a monorepo package reads its own baselines' paths as written.
  const diff = gitBytes(root, [
    'diff',
    '--relative',
    '--name-status',
    '-M',
    '-z',
    mergeBase,
    '--',
    snapshotDir,
  ]);
  if (diff.status !== 0) {
    throw new Error(
      `git diff against ${mergeBase.slice(0, 7)} failed: ${diff.stderr.split('\n')[0] ?? ''}`,
    );
  }
  const fields = diff.stdout.toString('utf8').split('\0');
  for (let at = 0; at < fields.length; ) {
    const code = (fields[at++] ?? '').trim();
    if (!code) break; // the -z stream ends with its own separator
    if (code.startsWith('R')) {
      const from = fields[at++] ?? '';
      const to = fields[at++] ?? '';
      // A rename git detected against the merge base: identical content is a move, and a
      // move is nothing to review. Anything less similar is the old baseline gone and a
      // new one in its place — the only shape the report can show both sides of.
      if (Number.parseInt(code.slice(1), 10) !== 100) {
        changes.push({ path: inside(from), kind: 'deleted' }, { path: inside(to), kind: 'added' });
      }
      continue;
    }
    const file = fields[at++] ?? '';
    // A modification, an addition, a deletion — and anything else (a type change, a copy)
    // still deserves the full read-and-compare a modification gets, never silence.
    changes.push({
      path: inside(file),
      kind: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
    });
  }

  const untracked = gitBytes(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    snapshotDir,
  ]);
  if (untracked.status !== 0) {
    throw new Error(
      `git could not list untracked files under ${snapshotDir}: ` +
        `${untracked.stderr.split('\n')[0] ?? ''}`,
    );
  }
  for (const file of untracked.stdout.toString('utf8').split('\0')) {
    if (file) changes.push({ path: inside(file), kind: 'added' });
  }
  return changes;
}

/** Write one artifact under the diff directory and return its path relative to the summary. */
async function writeArtifact(
  context: DiffContext,
  change: BaselineChange,
  kind: 'expected' | 'actual' | 'diff',
  bytes: Uint8Array,
): Promise<string> {
  const relative = path.join('shots', change.path.replace(/\.png$/, '') + `-${kind}.png`);
  const target = path.join(context.diffDir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return relative;
}

/**
 * A baseline's bytes as they were at the merge base, read binary-safe out of git. The
 * leading "./" makes the path resolve from this directory — without it, a revision path is
 * read from the repository root and every lookup from a monorepo package misses.
 */
function baselineAt(context: DiffContext, change: BaselineChange): Uint8Array {
  const shown = gitBytes(context.root, [
    'show',
    `${context.mergeBase}:./${context.snapshotDir}/${change.path}`,
  ]);
  if (shown.status !== 0) {
    throw new Error(
      `git could not read ${context.snapshotDir}/${change.path} at ` +
        `${context.mergeBase.slice(0, 7)}`,
    );
  }
  return new Uint8Array(shown.stdout);
}

/** One git-reported change, turned into the capture the report and summary already carry. */
async function entryFor(
  change: BaselineChange,
  parsed: ParsedSnapshotPath,
  context: DiffContext,
): Promise<CaptureResult> {
  const base = {
    ...storyNames(parsed.storyId),
    storyId: parsed.storyId,
    width: parsed.width,
    ...(parsed.mode ? { mode: parsed.mode } : {}),
    ...(parsed.state ? { state: parsed.state } : {}),
    snapshotPath: change.path,
  };

  if (change.kind === 'deleted') {
    const expected = baselineAt(context, change);
    return {
      ...base,
      status: 'removed',
      artifacts: { expected: await writeArtifact(context, change, 'expected', expected) },
    };
  }

  const actual = new Uint8Array(
    await readFile(path.join(context.snapshotAbs, change.path)),
  );
  if (change.kind === 'added') {
    return {
      ...base,
      status: 'new',
      size: pngSize(actual),
      artifacts: { actual: await writeArtifact(context, change, 'actual', actual) },
    };
  }

  // Modified: the pixels decide. A re-encoded baseline — bytes moved, image identical — is
  // bookkeeping, not a change, and is listed as unchanged rather than reviewed.
  const expected = baselineAt(context, change);
  const comparison = comparePng(expected, actual, context.threshold);
  if (comparison.diffPixels === 0) {
    return { ...base, status: 'unchanged', artifacts: {} };
  }

  const [expectedPath, actualPath, diffPath] = await Promise.all([
    writeArtifact(context, change, 'expected', expected),
    writeArtifact(context, change, 'actual', actual),
    writeArtifact(context, change, 'diff', comparison.diff),
  ]);
  const image = decodePng(comparison.diff);
  const { regions, dropped } = findRegions(image.rgba, image.width, image.height, {
    max: MAX_REGIONS,
  });
  return {
    ...base,
    status: 'changed',
    diffPixels: comparison.diffPixels,
    diffRatio: comparison.diffPixels / (comparison.width * comparison.height),
    size: { width: comparison.width, height: comparison.height },
    ...(regions.length > 0 ? { regions } : {}),
    ...(dropped > 0 ? { regionsDropped: dropped } : {}),
    artifacts: { expected: expectedPath, actual: actualPath, diff: diffPath },
  };
}

/**
 * Review the baseline changes a branch makes, without a run.
 *
 * A pull request that updates baselines shows a reviewer two opaque PNGs per file. This
 * renders the same report the run does, from git alone: what the merge base had, what the
 * working tree has, and the difference between the two — so the reviewer sees the change,
 * not the encoding. It is a review aid, not a gate: the exit code is 0 whatever the
 * baselines did, and 1 only when there was nothing to diff against.
 */
export async function diffCommand(options: DiffOptions): Promise<number> {
  const { config, filepath } = await loadConfig(options.root);
  // A trailing separator or a redundant "./" in the configured directory would survive into
  // every git path, so the configured value is normalised before any command reads it.
  const snapshotDir = path.posix.normalize(config.snapshotDir).replace(/\/+$/, '');

  if (!isGitRepo(options.root)) {
    process.stderr.write('Not a git repository — diopsis diff reads the baseline history from git.\n');
    return 1;
  }

  // `origin/main` is where CI's verdict comes from; a clone without the remote still has
  // `main`, and wherever both exist they name the same history.
  const base = options.base ?? (refExists(options.root, 'origin/main') ? 'origin/main' : 'main');
  if (!refExists(options.root, base)) {
    process.stderr.write(
      options.base === undefined
        ? 'No origin/main and no main to diff against. Name a base: diopsis diff <ref>\n'
        : `Unknown base "${base}" — git has no such ref.\n`,
    );
    return 1;
  }

  const merged = gitBytes(options.root, ['merge-base', base, 'HEAD']);
  if (merged.status !== 0) {
    process.stderr.write(`No common history between ${base} and HEAD — nothing to diff.\n`);
    return 1;
  }
  const mergeBase = merged.stdout.toString('utf8').trim();

  const context: DiffContext = {
    root: options.root,
    mergeBase,
    snapshotDir,
    snapshotAbs: path.resolve(options.root, snapshotDir),
    diffDir: path.resolve(options.root, config.outputDir, 'diff'),
    threshold: config.compare.threshold,
  };

  const warnings: string[] = [];
  const entries: CaptureResult[] = [];
  for (const change of baselineChanges(context.root, snapshotDir, mergeBase)) {
    if (!change.path.endsWith('.png')) continue;
    const parsed = parseSnapshotPath(change.path);
    if (!parsed) {
      warnings.push(
        `${snapshotDir}/${change.path} does not follow the baseline naming — ignored.`,
      );
      continue;
    }
    if (options.platform !== undefined && parsed.platform !== options.platform) continue;

    try {
      entries.push(await entryFor(change, parsed, context));
    } catch (error) {
      // A baseline that cannot be read or decoded is visible as a failure in the report,
      // never dropped from it — a review aid that omits a change reviews nothing at all.
      entries.push({
        ...storyNames(parsed.storyId),
        storyId: parsed.storyId,
        width: parsed.width,
        ...(parsed.mode ? { mode: parsed.mode } : {}),
        status: 'failed',
        snapshotPath: change.path,
        error: error instanceof Error ? error.message : String(error),
        artifacts: {},
      });
    }
  }

  entries.sort(
    (a, b) =>
      a.storyId.localeCompare(b.storyId) ||
      a.width - b.width ||
      (a.mode ?? '').localeCompare(b.mode ?? '') ||
      (a.state ?? '').localeCompare(b.state ?? ''),
  );

  const summary: RunSummary = {
    diopsis: 1,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    mode: 'diff',
    base,
    mergeBase,
    snapshotDir,
    totals: totalsFor(entries),
    changedStories: changedStoriesOf(entries),
    captures: entries,
  };

  await mkdir(context.diffDir, { recursive: true });
  const summaryPath = path.join(context.diffDir, 'summary.json');
  const reportPath = path.join(context.diffDir, 'report.html');
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(reportPath, await renderReport(summary, context.diffDir), 'utf8');

  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);

  const { totals } = summary;
  const show = (target: string): string => path.relative(options.root, target) || target;
  const lines = [
    `Diopsis · diff against ${base} (${mergeBase.slice(0, 7)})`,
    `  config    ${filepath ? path.relative(options.root, filepath) : 'defaults (no config file)'}`,
    `  baselines ${snapshotDir}`,
    ...(options.platform ? [`  platform  ${options.platform}`] : []),
    '',
  ];

  if (entries.length === 0) {
    lines.push('No baseline changes against this base.', '');
  } else {
    const counts = [
      `${totals.unchanged} unchanged`,
      ...(totals.changed ? [`${totals.changed} changed`] : []),
      ...(totals.new ? [`${totals.new} new`] : []),
      ...(totals.removed ? [`${totals.removed} removed`] : []),
      ...(totals.renderFailed ? [`${totals.renderFailed} failed to render`] : []),
      ...(totals.failed ? [`${totals.failed} failed`] : []),
    ];
    lines.push(`  ${counts.join(' · ')}`, '');

    for (const capture of entries) {
      if (capture.status === 'unchanged') continue;
      const mark =
        capture.status === 'changed'
          ? '~'
          : capture.status === 'new'
            ? '+'
            : capture.status === 'removed'
              ? '-'
              : '!';
      const detail =
        capture.diffPixels === undefined
          ? capture.status
          : `${capture.diffPixels.toLocaleString('en-US')} px differ`;
      lines.push(
        `  ${mark} ${capture.storyId} @${capture.width}` +
          `${capture.mode ? ` [${capture.mode}]` : ''}  ${detail}`,
      );
      if (capture.error) {
        for (const line of capture.error.split('\n').slice(0, 2)) {
          if (line.trim()) lines.push(`      ${line.trim()}`);
        }
      }
    }
    lines.push('');
  }

  lines.push(`  report   ${show(reportPath)}`, `  summary  ${show(summaryPath)}`, '');
  process.stdout.write(lines.join('\n'));

  if (options.open) openWithDesktop(reportPath);
  return 0;
}
