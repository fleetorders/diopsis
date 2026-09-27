import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readPreviewStats, resolveAffected } from '../affected.ts';
import { loadConfig } from '../config.ts';
import { gitLines, isGitRepo, refExists } from '../git.ts';
import {
  loosenedStoryIds,
  platformToken,
  resolveMatrix,
  type Capture,
  type ResolvedMatrix,
} from '../matrix.ts';
import { renderReport } from '../report/html.ts';
import { totalsFor, type CarriedCapture, type RunSummary } from '../report/summary.ts';
import { distRoot, generateProject, projectDir } from '../runner/generate.ts';
import { runPlaywright } from '../runner/execute.ts';
import { serveStatic } from '../server.ts';
import { readStoryIndex, type StoryEntry } from '../story-index.ts';

export interface RunOptions {
  root: string;
  /** Regenerate baselines instead of verifying against them. */
  update?: boolean;
  /** Substring filter on story ids. */
  grep?: string;
  /**
   * Capture only the stories a change could reach; everything else is carried from its
   * baseline. `true` compares against the default base; a string names it.
   */
  changed?: string | true;
  /** Keep the generated Playwright project for inspection. */
  keep?: boolean;
  /** Playwright pass-through arguments. */
  passthrough?: string[];
}

/**
 * The run's first line. The story count is of the stories actually captured — skipped,
 * unwatched and filtered-out stories capture nothing, and a header that counts the whole
 * index promises work the run will not do.
 */
export function headerLine(captures: Capture[], grep: string | undefined): string {
  const captured = new Set(captures.map((capture) => capture.storyId)).size;
  const matched = grep ? ` (matched "${grep}")` : '';
  return `Diopsis · ${captured} stories → ${captures.length} captures${matched} · ${platformToken()}`;
}

/**
 * The whole header block: what the run will capture, in the settings that shaped it. The
 * loosened line is the visible half of per-story tolerance — a story comparing more
 * loosely than the config is a deliberate exception, and an exception is only safe while
 * someone can see it.
 */
export function headerBlock(input: {
  captures: Capture[];
  grep?: string;
  /** Config source as shown to the user — a relative path, or 'defaults (no config file)'. */
  configSource: string;
  /** The configured capture scope — the stories departing from it are counted beside it. */
  capture: 'page' | 'component';
  storybookDir: string;
  snapshotDir: string;
  skipped: string[];
  unwatched: string[];
  loosened: string[];
  /** Names of the configured modes, when there are any. */
  modes?: string[];
  /** The --changed decision, already phrased, when change-aware capture shaped the run. */
  changed?: string;
}): string {
  // Like the loosened line, the scope line exists to make an exception visible: it appears
  // only when something departs from the whole-page default, and counts the stories that
  // run against the configured scope.
  const offScope = new Set(
    input.captures.filter((capture) => capture.scope !== input.capture).map((capture) => capture.storyId),
  ).size;
  const scopeLine =
    input.capture === 'page' && offScope === 0
      ? ''
      : `  scope     ${input.capture}` +
        (offScope > 0
          ? ` (${offScope} ${offScope === 1 ? 'story' : 'stories'} ` +
            `${input.capture === 'page' ? 'component' : 'page'})`
          : '') +
        '\n';

  // Like the scope line, the modes line says what shaped the matrix: every mode multiplies
  // every capture, so the names belong where the cost is read.
  const modesLine = input.modes?.length ? `  modes     ${input.modes.join(', ')}\n` : '';

  return (
    `${headerLine(input.captures, input.grep)}\n` +
    `  config    ${input.configSource}\n` +
    `  storybook ${input.storybookDir}\n` +
    `  baselines ${input.snapshotDir}\n` +
    (input.changed ? `  changed   ${input.changed}\n` : '') +
    modesLine +
    scopeLine +
    (input.skipped.length ? `  skipped   ${input.skipped.length} stories (diopsis:skip)\n` : '') +
    (input.unwatched.length
      ? `  unwatched ${input.unwatched.length} stories (no widths: viewports.default is empty)\n`
      : '') +
    (input.loosened.length
      ? `  loosened  ${input.loosened.length} ${input.loosened.length === 1 ? 'story' : 'stories'} (diopsis:threshold / max-diff-* tags)\n`
      : '') +
    '\n'
  );
}

/**
 * Why a run captured nothing, as the user's next action rather than one opaque line. Every
 * count is of the stories the run actually considered — under --grep, of the matching
 * ones — so each message stays true for the run that printed it.
 */
export function explainEmptyRun(input: {
  stories: StoryEntry[];
  matrix: ResolvedMatrix;
  /** The configured directory as written, for the message that names it. */
  storybookDir: string;
  grep?: string;
}): string[] {
  const { stories, matrix, storybookDir, grep } = input;

  if (stories.length === 0) {
    return [`The story index in ${storybookDir} lists no stories. Rebuild the Storybook.`];
  }

  const matching = grep ? stories.filter((story) => story.id.includes(grep)) : stories;
  if (matching.length === 0) {
    return [`No story id contains "${grep}" (${stories.length} stories in the index).`];
  }

  const skipped = new Set(matrix.skipped);
  if (matching.every((story) => skipped.has(story.id))) {
    return matching.length === 1
      ? ['All 1 story is tagged diopsis:skip.']
      : [`All ${matching.length} stories are tagged diopsis:skip.`];
  }

  // What is left had no widths to capture at; this is the message the run already printed.
  const unwatched = new Set(matrix.unwatched);
  const count = matching.filter((story) => unwatched.has(story.id)).length;
  return [
    'Nothing to capture.',
    `  unwatched ${count} stories (no widths: viewports.default is empty)`,
  ];
}

export interface ChangedSet {
  base: string;
  mergeBase: string;
  /** Repo-root-relative POSIX paths, deduplicated and sorted. */
  files: string[];
}

/**
 * Everything that differs from `base` (default `origin/main`, falling back to `main` like
 * `diff`): the branch's commits through its merge base, plus what is staged, unstaged or
 * untracked in the working tree — a developer editing one component sees the same affected
 * set locally that CI sees from the commits alone. Deletions are excluded (the diff
 * filter), so a file gone from the build cannot demand a full matrix it can no longer
 * affect; renames arrive as their new path.
 */
export function changedFilesSince(root: string, requested?: string): ChangedSet {
  if (!isGitRepo(root)) {
    throw new Error('Not a git repository — --changed reads the change set from git.');
  }
  const base = requested ?? (refExists(root, 'origin/main') ? 'origin/main' : 'main');
  if (!refExists(root, base)) {
    throw new Error(
      requested === undefined
        ? 'No origin/main and no main to compare against. Name a base: diopsis run --changed <ref>'
        : `Unknown base "${base}" — git has no such ref.`,
    );
  }
  const merged = gitLines(root, ['merge-base', base, 'HEAD']);
  if (!merged || merged.length === 0) {
    throw new Error(`No common history between ${base} and HEAD — nothing to compare.`);
  }
  const mergeBase = merged[0]!;

  const files = new Set<string>();
  // Three views because a change can sit in any one of them alone: committed since the
  // merge base (including the working tree's edits of it), staged against the merge base
  // (an edit staged and then reverted in the files), and untracked altogether.
  for (const args of [
    ['diff', '--name-only', '-M', '--diff-filter=ACMR', mergeBase],
    ['diff', '--name-only', '-M', '--diff-filter=ACMR', '--cached', mergeBase],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    const listed = gitLines(root, args);
    if (listed === undefined) {
      throw new Error(`git could not list changes (${args.join(' ')}).`);
    }
    for (const file of listed) files.add(file);
  }
  return { base, mergeBase, files: [...files].sort() };
}

/** The three things the `changed` header line has to say. */
export type ChangedView =
  | { kind: 'full'; reason: string }
  | { kind: 'set'; affected: number; of: number; base: string; shortSha: string }
  | { kind: 'nothing'; base: string };

export function changedLine(view: ChangedView): string {
  if (view.kind === 'full') return `full run — ${view.reason}`;
  if (view.kind === 'nothing') return `nothing affected since ${view.base}`;
  return `${view.affected} of ${view.of} stories affected since ${view.base} (${view.shortSha})`;
}

/**
 * Split the planned captures into what a change could reach — and is therefore shot — and
 * what it could not, which is carried: its baseline stands, listed in the summary and the
 * report rather than quietly skipped.
 */
export function splitByAffected(
  captures: Capture[],
  affected: Iterable<string>,
): { captures: Capture[]; carried: CarriedCapture[] } {
  const ids = new Set(affected);
  const shot: Capture[] = [];
  const carried: CarriedCapture[] = [];
  for (const capture of captures) {
    if (ids.has(capture.storyId)) shot.push(capture);
    else {
      carried.push({
        storyId: capture.storyId,
        width: capture.width,
        ...(capture.mode ? { mode: capture.mode } : {}),
      });
    }
  }
  return { captures: shot, carried };
}

export async function runCommand(options: RunOptions): Promise<number> {
  const { config, filepath } = await loadConfig(options.root);
  const storybookDir = path.resolve(options.root, config.storybookDir);

  if (!existsSync(storybookDir)) {
    process.stderr.write(
      `No Storybook build at ${config.storybookDir}. Build it first, or point ` +
        `storybookDir at the build output.\n`,
    );
    return 1;
  }

  const stories = await readStoryIndex(storybookDir);
  const matrix = resolveMatrix(stories, config);

  const captures = options.grep
    ? matrix.captures.filter((capture) => capture.storyId.includes(options.grep!))
    : matrix.captures;

  for (const warning of matrix.warnings) process.stderr.write(`warning: ${warning}\n`);

  // --changed narrows the matrix to what a change could reach; the rest is carried, its
  // baseline standing, visibly — a silent cap reads as "all green" when it is not. The
  // update path never narrows: regenerating baselines always shoots the whole matrix.
  let planned = captures;
  let carried: CarriedCapture[] | undefined;
  let affected: RunSummary['affected'];
  let changedText: string | undefined;
  let bypassed = false;

  if (options.changed !== undefined && options.changed !== '' && !options.update) {
    const changeSet = changedFilesSince(
      options.root,
      typeof options.changed === 'string' ? options.changed : undefined,
    );
    const stats = await readPreviewStats(storybookDir);
    const result = resolveAffected({
      changed: changeSet.files,
      stories,
      ...(stats ? { stats } : {}),
    });
    affected = {
      base: changeSet.base,
      mergeBase: changeSet.mergeBase,
      changedFiles: changeSet.files.length,
      ...(result.kind === 'full' ? { full: result.reason } : {}),
    };

    if (result.kind === 'full') {
      changedText = changedLine({ kind: 'full', reason: result.reason });
    } else {
      const split = splitByAffected(captures, result.storyIds);
      planned = split.captures;
      carried = split.carried;
      // A change that reaches nothing the run watches is a pass, not an empty run: every
      // question it raises is already answered by the committed baselines.
      bypassed = planned.length === 0 && carried.length > 0;
      changedText = changedLine(
        bypassed
          ? { kind: 'nothing', base: changeSet.base }
          : {
              kind: 'set',
              affected: new Set(planned.map((capture) => capture.storyId)).size,
              of: new Set(captures.map((capture) => capture.storyId)).size,
              base: changeSet.base,
              shortSha: changeSet.mergeBase.slice(0, 7),
            },
      );
    }
  }

  // The zero-capture bypass writes the summary without a browser and exits 0: the run is
  // done, the report says what stood and why, and CI reads a pass.
  if (bypassed) {
    process.stdout.write(
      headerBlock({
        captures: planned,
        ...(options.grep ? { grep: options.grep } : {}),
        ...(changedText ? { changed: changedText } : {}),
        capture: config.capture,
        configSource: filepath ? path.relative(options.root, filepath) : 'defaults (no config file)',
        storybookDir: config.storybookDir,
        snapshotDir: config.snapshotDir,
        skipped: matrix.skipped,
        unwatched: matrix.unwatched,
        loosened: [],
      }),
    );

    const summary: RunSummary = {
      diopsis: 1,
      createdAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      mode: 'run',
      snapshotDir: config.snapshotDir,
      // Bypassed means nothing was shot, so the comparison counts are all zero; what the
      // summary adds is the carried set that stands in for them.
      totals: { ...totalsFor([]), carried: carried!.length },
      changedStories: [],
      captures: [],
      ...(affected ? { affected } : {}),
      carried: carried!,
    };

    const outputDir = path.resolve(options.root, config.outputDir);
    await mkdir(outputDir, { recursive: true });
    const summaryPath = path.join(outputDir, 'summary.json');
    const reportPath = path.join(outputDir, 'report.html');
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(reportPath, await renderReport(summary, outputDir), 'utf8');

    const show = (target: string): string => path.relative(options.root, target) || target;
    process.stdout.write(`\n  report   ${show(reportPath)}\n  summary  ${show(summaryPath)}\n`);
    return 0;
  }

  if (planned.length === 0) {
    for (const line of explainEmptyRun({
      stories,
      matrix,
      storybookDir: config.storybookDir,
      ...(options.grep ? { grep: options.grep } : {}),
    })) {
      process.stderr.write(`${line}\n`);
    }
    return 1;
  }

  // Captures, not stories: a viewport matrix multiplies, and every cost that matters —
  // runtime, repository weight, review effort — scales with captures (DECISIONS.md §3).
  process.stdout.write(
    headerBlock({
      captures: planned,
      ...(options.grep ? { grep: options.grep } : {}),
      ...(changedText ? { changed: changedText } : {}),
      capture: config.capture,
      configSource: filepath ? path.relative(options.root, filepath) : 'defaults (no config file)',
      storybookDir: config.storybookDir,
      snapshotDir: config.snapshotDir,
      skipped: matrix.skipped,
      unwatched: matrix.unwatched,
      loosened: loosenedStoryIds(planned, config.compare),
      ...(config.modes ? { modes: Object.keys(config.modes) } : {}),
    }),
  );

  const server = await serveStatic(storybookDir);
  let project;
  try {
    project = await generateProject({
      root: options.root,
      config,
      captures: planned,
      baseUrl: server.url,
      reporterPath: path.join(distRoot(), 'reporter.js'),
      // The retries the reporter sees are the retries the generated project runs with, so
      // it starts region work only on the attempt that can decide a capture.
      ...(options.update ? { mode: 'update' as const } : {}),
      reporterOptions: {
        planPath: path.join(projectDir(options.root), 'plan.json'),
        outputDir: path.resolve(options.root, config.outputDir),
        snapshotDir: config.snapshotDir,
        snapshotDirAbs: path.resolve(options.root, config.snapshotDir),
        mode: options.update ? 'update' : 'run',
        retries: options.update ? 0 : config.stabilize.retries,
        platform: process.platform,
        arch: process.arch,
        createdAt: new Date().toISOString(),
        ...(affected ? { affected } : {}),
        ...(carried ? { carried } : {}),
      },
    });

    const args = [...(options.passthrough ?? [])];
    if (options.update) args.push('--update-snapshots=all');

    return await runPlaywright({ root: options.root, configPath: project.configPath, args });
  } finally {
    await server.close();
    if (project && !options.keep) await project.cleanup();
  }
}
