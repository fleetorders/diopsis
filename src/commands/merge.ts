import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../config.ts';
import { platformToken } from '../matrix.ts';
import { renderReport } from '../report/html.ts';
import {
  changedStoriesOf,
  needsReview,
  totalsFor,
  type CaptureArtifacts,
  type CaptureResult,
  type CarriedCapture,
  type RunSummary,
} from '../report/summary.ts';
import { displayPath } from '../paths.ts';

export interface MergeOptions {
  root: string;
  /** Directories to search for shard runs. Default: the configured output directory. */
  dirs?: string[];
}

/** `shard-2-of-4` — the directory every shard run writes its summary into. */
const SHARD_DIR = /^shard-(\d+)-of-(\d+)$/;

/** One found shard: where it lives, which of how many it is, and what it recorded. */
interface FoundShard {
  index: number;
  total: number;
  /** Absolute directory holding the shard's summary and its artifacts. */
  dir: string;
  summary: RunSummary;
}

function parseShardDir(name: string): { index: number; total: number } | undefined {
  const match = SHARD_DIR.exec(name);
  if (!match) return undefined;
  return {
    index: Number.parseInt(match[1] ?? '', 10),
    total: Number.parseInt(match[2] ?? '', 10),
  };
}

/**
 * Every shard directory at or below `root`. Shards are written directly under the output
 * directory and keep their names when downloaded, but a CI artifact can nest them a level
 * deeper, so the walk is recursive — and the directory handed to the command may itself be
 * a shard's. An unreadable directory contributes nothing; the command speaks only when
 * nothing at all was found.
 */
async function findShardDirs(root: string): Promise<string[]> {
  const found: string[] = [];

  async function visit(dir: string): Promise<void> {
    if (parseShardDir(path.basename(dir)) && existsSync(path.join(dir, 'summary.json'))) {
      found.push(dir);
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(path.join(dir, entry.name));
    }
  }

  await visit(root);
  return found.sort();
}

/**
 * Combine sharded runs into one review.
 *
 * A shard writes its own summary and artifacts under `shard-<i>-of-<n>/`; this reads those
 * back, checks they are all of one run — same total, same platform, every index exactly
 * once, no capture in two shards — and writes the one summary and report an unsharded run
 * of the same plan would have written, artifacts referenced back through the shard
 * directories they live in.
 */
export async function mergeCommand(options: MergeOptions): Promise<number> {
  const { config } = await loadConfig(options.root);
  const roots = (options.dirs?.length ? options.dirs : [config.outputDir]).map((dir) =>
    path.resolve(options.root, dir),
  );

  const found = new Set<string>();
  for (const root of roots) for (const dir of await findShardDirs(root)) found.add(dir);
  const dirs = [...found].sort();

  const say = (dir: string): string => displayPath(options.root, dir);
  const fail = (message: string): number => {
    process.stderr.write(`${message}\n`);
    return 2;
  };

  if (dirs.length === 0) {
    return fail(
      'No shard runs under ' +
        roots.map((root) => displayPath(options.root, root)).join(', ') +
        '. A sharded run writes shard-<i>-of-<n>/ beside its report; merge reads those back.',
    );
  }

  const shards: FoundShard[] = [];
  for (const dir of dirs) {
    let summary: RunSummary;
    try {
      summary = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8')) as RunSummary;
    } catch (error) {
      return fail(
        `Could not read ${say(dir)}/summary.json: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(summary.captures)) {
      return fail(`${say(dir)}/summary.json is not a run summary — it lists no captures.`);
    }
    // The directory a shard writes is part of its identity: the index the merge groups by
    // is read from it, and a summary that disagrees names a directory moved or renamed by
    // hand, whose place in the run is no longer what its path says.
    const named = parseShardDir(path.basename(dir))!;
    const recorded = summary.shard;
    if (recorded && (recorded.index !== named.index || recorded.total !== named.total)) {
      return fail(
        `${say(dir)}/summary.json says shard ${recorded.index} of ${recorded.total}, but its ` +
          'directory says otherwise — keep each shard under the name its run gave it.',
      );
    }
    shards.push({ ...named, dir, summary });
  }

  // One run's worth of shards, first of three checks: they agree about how many there are.
  const totals = new Set(shards.map((shard) => shard.total));
  if (totals.size > 1) {
    return fail(
      'The shard runs disagree about how many shards there are: ' +
        shards
          .map((shard) => `${say(shard.dir)} (shard ${shard.index} of ${shard.total})`)
          .join(', ') +
        '.',
    );
  }
  const shardTotal = shards[0]!.total;

  // Second: every index exactly once — a missing shard is half a review, a duplicated one
  // is two runs' work wearing one total.
  const byIndex = new Map<number, string[]>();
  for (const shard of shards) {
    const at = byIndex.get(shard.index) ?? [];
    at.push(say(shard.dir));
    byIndex.set(shard.index, at);
  }
  const duplicated = [...byIndex.entries()].filter(([, at]) => at.length > 1);
  if (duplicated.length > 0) {
    return fail(
      duplicated
        .map(
          ([index, at]) =>
            `Shard ${index} of ${shardTotal} appears more than once: ${at.join(', ')}.`,
        )
        .join('\n'),
    );
  }
  const missing = Array.from({ length: shardTotal }, (_, at) => at + 1).filter(
    (index) => !byIndex.has(index),
  );
  if (missing.length > 0) {
    return fail(
      `Missing ${missing.map((index) => `shard ${index}`).join(', ')} of ${shardTotal} — ` +
        `found ${[...byIndex.keys()].sort((a, b) => a - b).join(', ')}.`,
    );
  }

  // Third: the same machine class and the same kind of run. Shards from different
  // platforms or different runs would merge into a report that looks whole and compares
  // nothing — baselines differ per platform, and a run and an update adopt differently.
  const disagreements: string[] = [];
  const compare = (field: string, value: (shard: FoundShard) => string): void => {
    const groups = new Map<string, string[]>();
    for (const shard of shards) {
      const at = groups.get(value(shard)) ?? [];
      at.push(path.basename(shard.dir));
      groups.set(value(shard), at);
    }
    if (groups.size > 1) {
      disagreements.push(
        `${field}: ` +
          [...groups.entries()].map(([one, at]) => `${one} (${at.join(', ')})`).join('; '),
      );
    }
  };
  compare('platform', (shard) => platformToken(shard.summary.platform, shard.summary.arch));
  compare('run mode', (shard) => shard.summary.mode);
  compare('snapshot directory', (shard) => shard.summary.snapshotDir);
  // Shards of a change-aware run narrowed their plans against the same base and merge base;
  // the summary names both, so a disagreement is one run's shards wearing another's totals.
  compare('the affected set', (shard) => {
    const affected = shard.summary.affected;
    return affected
      ? `${affected.base} (${affected.mergeBase.slice(0, 7)}, ` +
        `${affected.changedFiles} ${affected.changedFiles === 1 ? 'file' : 'files'})`
      : 'no --changed decision';
  });
  if (disagreements.length > 0) {
    return fail(`The shard runs disagree about ${disagreements.join('; and about ')}.`);
  }

  // Complete indexes can still carry two different plans — one shard taken with --grep,
  // one without; shards from two branches. A capture in two shards would be reviewed twice
  // while the report looked like one whole run.
  const owner = new Map<string, string>();
  for (const shard of shards) {
    for (const capture of shard.summary.captures) {
      const first = owner.get(capture.snapshotPath);
      if (first !== undefined) {
        return fail(
          `${capture.storyId} @${capture.width}` +
            `${capture.mode ? ` [${capture.mode}]` : ''}` +
            `${capture.state ? ` {${capture.state}}` : ''} is in both ${say(first)} and ` +
            `${say(shard.dir)} — the shards were not taken from the same plan.`,
        );
      }
      owner.set(capture.snapshotPath, shard.dir);
    }
  }

  const first = shards[0]!;
  const mergedDir = path.resolve(options.root, config.outputDir, 'merged');
  // Artifacts are recorded relative to the summary that lists them; from the merged
  // directory they are reached back through the shard they live in.
  const rewrite = (shardDir: string, relative: string): string =>
    displayPath(mergedDir, path.resolve(shardDir, relative));

  const captures: CaptureResult[] = shards
    .flatMap((shard) =>
      shard.summary.captures.map((capture) => {
        const artifacts: CaptureArtifacts = {};
        for (const kind of ['expected', 'actual', 'diff'] as const) {
          const relative = capture.artifacts[kind];
          if (relative !== undefined) artifacts[kind] = rewrite(shard.dir, relative);
        }
        return { ...capture, artifacts };
      }),
    )
    // Plan order, rebuilt from each capture's own coordinates: shards arrive in index
    // order and each holds whole stories, so sorting by story, width and mode lays the
    // merged run out the way an unsharded one would have listed it.
    .sort(
      (a, b) =>
        a.storyId.localeCompare(b.storyId) ||
        a.width - b.width ||
        (a.mode ?? '').localeCompare(b.mode ?? '') ||
        (a.state ?? '').localeCompare(b.state ?? '') ||
        a.status.localeCompare(b.status),
    );

  // A change-aware run carries the same not-shot captures in every shard — each shard's
  // plan is the whole matrix narrowed by the same --changed decision — so the merged run
  // lists them once, not once per shard. Identity is the capture's own coordinates.
  const carriedByPlan = new Map<string, CarriedCapture>();
  for (const shard of shards) {
    for (const entry of shard.summary.carried ?? []) {
      carriedByPlan.set(
        `${entry.storyId}\n${entry.width}\n${entry.mode ?? ''}\n${entry.state ?? ''}`,
        entry,
      );
    }
  }
  const carried = [...carriedByPlan.values()].sort(
    (a, b) =>
      a.storyId.localeCompare(b.storyId) ||
      a.width - b.width ||
      (a.mode ?? '').localeCompare(b.mode ?? '') ||
      (a.state ?? '').localeCompare(b.state ?? ''),
  );

  const summary: RunSummary = {
    diopsis: 1,
    // The run's time, not the merge's: the newest shard is when the run finished, and
    // re-merging the same shards writes the same summary.
    createdAt: shards.reduce(
      (latest, shard) => (shard.summary.createdAt > latest ? shard.summary.createdAt : latest),
      first.summary.createdAt,
    ),
    platform: first.summary.platform,
    arch: first.summary.arch,
    mode: first.summary.mode,
    ...(shards.some((shard) => shard.summary.interrupted) ? { interrupted: true } : {}),
    // A merged run is accepted from where it was merged; the plain output directory holds
    // either nothing or some other run.
    acceptFrom: `${config.outputDir.replace(/\/+$/, '')}/merged`,
    snapshotDir: first.summary.snapshotDir,
    totals: {
      ...totalsFor(captures),
      ...(carried.length > 0 ? { carried: carried.length } : {}),
    },
    changedStories: changedStoriesOf(captures),
    captures,
    ...(first.summary.affected ? { affected: first.summary.affected } : {}),
    ...(carried.length > 0 ? { carried } : {}),
  };

  await mkdir(mergedDir, { recursive: true });
  const summaryPath = path.join(mergedDir, 'summary.json');
  const reportPath = path.join(mergedDir, 'report.html');
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(reportPath, await renderReport(summary, mergedDir), 'utf8');

  const { totals: merged } = summary;
  const show = (target: string): string => displayPath(options.root, target);

  const counts = [
    `${merged.unchanged} unchanged`,
    ...(merged.changed ? [`${merged.changed} changed`] : []),
    ...(merged.new ? [`${merged.new} new`] : []),
    ...(merged.removed ? [`${merged.removed} removed`] : []),
    ...(merged.renderFailed ? [`${merged.renderFailed} failed to render`] : []),
    ...(merged.failed ? [`${merged.failed} failed`] : []),
  ];

  const lines = [
    'Diopsis · ' +
      `${shardTotal} shards merged · ${merged.stories} stories → ${merged.captures} captures` +
      ` · ${platformToken(first.summary.platform, first.summary.arch)}`,
    ...(merged.notRun > 0 ? [`  run interrupted — ${merged.notRun} captures did not run`] : []),
    `  ${counts.join(' · ')}`,
    ...(merged.unstable > 0
      ? [`  ${merged.unstable} unstable — differed on one load, matched on the next`]
      : []),
    '',
  ];

  for (const capture of captures) {
    if (capture.status === 'unchanged' && !capture.unstable) continue;
    const detail = capture.unstable
      ? capture.unstableDiffPixels === undefined
        ? (capture.unstableStatus ?? 'unstable')
        : `${capture.unstableDiffPixels.toLocaleString('en-US')} px differ`
      : capture.diffPixels === undefined
        ? capture.status
        : `${capture.diffPixels.toLocaleString('en-US')} px differ`;
    const mark = capture.unstable ? '?' : capture.status === 'changed' ? '~' : '+';
    lines.push(
      `  ${mark} ${capture.storyId} @${capture.width}` +
        `${capture.mode ? ` [${capture.mode}]` : ''}  ${detail}`,
    );
    if (capture.status === 'render-failed' || capture.status === 'failed') {
      for (const line of (capture.error ?? '').split('\n').slice(0, 2)) {
        if (line.trim()) lines.push(`      ${line.trim()}`);
      }
    }
  }

  if (counts.length > 1 || merged.unstable > 0) lines.push('');
  lines.push(`  report   ${show(reportPath)}`, `  summary  ${show(summaryPath)}`);

  if (summary.changedStories.length > 0 && summary.mode === 'run') {
    lines.push('', `  Accept as the new baseline:  npx diopsis accept --from ${show(mergedDir)}`);
  }
  lines.push('');
  process.stdout.write(lines.join('\n'));

  // The verdict an unsharded run of the same plan would have given: review work or a
  // failure fails the merge; everything passing passes it.
  return captures.some((capture) => needsReview(capture.status)) ? 1 : 0;
}
