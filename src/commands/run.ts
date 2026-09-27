import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { consideredFiles, readPreviewStats, resolveAffected } from '../affected.ts';
import { baselineWeight } from '../baselines.ts';
import { resolveAxePath } from '../accessibility.ts';
import { recompressBaselines, writeRecompressReport } from '../compress.ts';
import { formatBytes, loadConfig, parseSize } from '../config.ts';
import { gitLines, isGitRepo, refExists } from '../git.ts';
import {
  loosenedStoryIds,
  platformToken,
  resolveMatrix,
  shardCaptures,
  type Capture,
  type ResolvedMatrix,
  type ShardSpec,
} from '../matrix.ts';
import { renderReport } from '../report/html.ts';
import { totalsFor, type CarriedCapture, type RunSummary } from '../report/summary.ts';
import { distRoot, generateProject, projectDir } from '../runner/generate.ts';
import { runPlaywright } from '../runner/execute.ts';
import { serveStatic } from '../server.ts';
import { readStoryIndex, type StoryEntry } from '../story-index.ts';
import { displayPath } from '../paths.ts';

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
  /** Capture only this shard's stories of the plan; `merge` joins shards back into one run. */
  shard?: ShardSpec;
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
  const stories = `${captured} ${captured === 1 ? 'story' : 'stories'}`;
  const shots = `${captures.length} ${captures.length === 1 ? 'capture' : 'captures'}`;
  return `Diopsis · ${stories} → ${shots}${matched} · ${platformToken()}`;
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
  /** The shard this run captures; absent for a whole-plan run. */
  shard?: ShardSpec;
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
  /** Budget usage against each configured ceiling, in the numbers the line prints. */
  budget?: { weight?: { used: number; cap: number }; captures?: { used: number; cap: number } };
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

  // The budget line exists only when there is something to say: a ceiling crossed, or
  // within 10% of it. A budget comfortably met is the set's normal state, not news.
  const verdict = (used: number, cap: number): 'over' | 'near' => (used > cap ? 'over' : 'near');
  const nearOrOver = (used: number, cap: number): boolean => used > cap || used >= 0.9 * cap;
  const weight = input.budget?.weight;
  const captureBudget = input.budget?.captures;
  const budgetLines =
    (weight && nearOrOver(weight.used, weight.cap)
      ? `  budget    ${formatBytes(weight.used)} of ${formatBytes(weight.cap)} — ${verdict(weight.used, weight.cap)}\n`
      : '') +
    (captureBudget && nearOrOver(captureBudget.used, captureBudget.cap)
      ? `  budget    ${captureBudget.used} of ${captureBudget.cap} captures — ${verdict(captureBudget.used, captureBudget.cap)}\n`
      : '');

  // A shard run's header says it is one: which of how many jobs, and this job's own counts,
  // so a CI log quoted alone still names what the job covered.
  const shardStories = new Set(input.captures.map((capture) => capture.storyId)).size;
  const shardLine = input.shard
    ? `  shard     ${input.shard.index} of ${input.shard.total} · ` +
      `${shardStories} ${shardStories === 1 ? 'story' : 'stories'}, ${input.captures.length} captures\n`
    : '';

  return (
    `${headerLine(input.captures, input.grep)}\n` +
    shardLine +
    `  config    ${input.configSource}\n` +
    `  storybook ${input.storybookDir}\n` +
    `  baselines ${input.snapshotDir}\n` +
    budgetLines +
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
        ...(capture.state ? { state: capture.state.name } : {}),
      });
    }
  }
  return { captures: shot, carried };
}

/**
 * Write a shard that captured nothing. The runner is not started at all — Playwright
 * treats an empty test list as a failure, and an empty shard is not one: it is a plan
 * split among more shards than it has stories, and the merge still expects its index.
 */
async function writeEmptyShard(input: {
  root: string;
  outputDir: string;
  snapshotDir: string;
  mode: 'run' | 'update';
  shard: ShardSpec;
  createdAt: string;
  /** Change-aware runs: the carried set every shard lists in full. */
  affected?: RunSummary['affected'];
  carried?: CarriedCapture[];
}): Promise<number> {
  const summary: RunSummary = {
    diopsis: 1,
    createdAt: input.createdAt,
    platform: process.platform,
    arch: process.arch,
    mode: input.mode,
    shard: input.shard,
    snapshotDir: input.snapshotDir,
    totals: { ...totalsFor([]), ...(input.carried ? { carried: input.carried.length } : {}) },
    changedStories: [],
    captures: [],
    ...(input.affected ? { affected: input.affected } : {}),
    ...(input.carried ? { carried: input.carried } : {}),
  };

  await mkdir(input.outputDir, { recursive: true });
  const summaryPath = path.join(input.outputDir, 'summary.json');
  const reportPath = path.join(input.outputDir, 'report.html');
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(reportPath, await renderReport(summary, input.outputDir), 'utf8');

  const show = (target: string): string => displayPath(input.root, target);
  process.stdout.write(
    [
      '  shard empty — the plan gave this shard no stories',
      `  report   ${show(reportPath)}`,
      `  summary  ${show(summaryPath)}`,
      '',
    ].join('\n'),
  );
  return 0;
}

export async function runCommand(options: RunOptions): Promise<number> {
  // Playwright's own --shard would split the run by test, scattering one story's captures
  // across shards and splitting its review. Diopsis shards by story, so the passthrough is
  // refused rather than quietly obeyed.
  const playwrightShard = options.passthrough?.find(
    (arg) => arg === '--shard' || arg.startsWith('--shard='),
  );
  if (playwrightShard) {
    process.stderr.write(
      `${playwrightShard} shards by test, not by story — a story's captures would land in ` +
        'different shards and its review would be split. Use --shard <i>/<n>.\n',
    );
    return 1;
  }

  const { config, filepath } = await loadConfig(options.root);
  const storybookDir = path.resolve(options.root, config.storybookDir);

  if (!existsSync(storybookDir)) {
    process.stderr.write(
      `No Storybook build at ${config.storybookDir}. Build it first, or point ` +
        `storybookDir at the build output.\n`,
    );
    return 1;
  }

  // The audit's library is the tested project's own, resolved before anything runs so a
  // missing install costs one line and no browser (DECISIONS.md D-041).
  let axePath: string | undefined;
  if (config.accessibility !== 'off') {
    try {
      axePath = resolveAxePath(options.root);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
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
    // Baselines and run output never reach a story's rendering, but they change on every
    // branch that accepts something — counted as unknown files, they forced a full run on
    // exactly the branches that most need a fast one.
    const own = (dir: string): string =>
      `${path.posix.normalize(dir.split(path.sep).join('/')).replace(/^\.\/|\/$/g, '')}/**`;
    const ignore = [own(config.snapshotDir), own(config.outputDir)];
    const result = resolveAffected({
      changed: changeSet.files,
      stories,
      ...(stats ? { stats } : {}),
      options: { ignore },
    });
    affected = {
      base: changeSet.base,
      mergeBase: changeSet.mergeBase,
      // The count is of the files the decision considered, not the raw diff: a run's own
      // output is ignored below but grows with every shard that finishes, and shards of
      // one run must report the same decision to be mergeable.
      changedFiles: consideredFiles(changeSet.files, ignore).length,
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
        ...(options.shard ? { shard: options.shard } : {}),
        ...(changedText ? { changed: changedText } : {}),
        capture: config.capture,
        configSource: filepath ? displayPath(options.root, filepath) : 'defaults (no config file)',
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
      ...(options.shard ? { shard: options.shard } : {}),
      snapshotDir: config.snapshotDir,
      // Bypassed means nothing was shot, so the comparison counts are all zero; what the
      // summary adds is the carried set that stands in for them.
      totals: { ...totalsFor([]), carried: carried!.length },
      changedStories: [],
      captures: [],
      ...(affected ? { affected } : {}),
      carried: carried!,
    };

    const outputDir = options.shard
      ? path.resolve(
          options.root,
          config.outputDir,
          `shard-${options.shard.index}-of-${options.shard.total}`,
        )
      : path.resolve(options.root, config.outputDir);
    await mkdir(outputDir, { recursive: true });
    const summaryPath = path.join(outputDir, 'summary.json');
    const reportPath = path.join(outputDir, 'report.html');
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(reportPath, await renderReport(summary, outputDir), 'utf8');

    const show = (target: string): string => displayPath(options.root, target);
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

  // A budget is judged against the whole set — the full matrix and every platform's bytes —
  // so a --grep run cannot report a budget as met by measuring a slice of it.
  const weightCap =
    config.budget?.weight !== undefined ? parseSize(config.budget.weight) : undefined;
  const budgetInput =
    weightCap !== undefined || config.budget?.captures !== undefined
      ? {
          ...(weightCap !== undefined
            ? {
                weight: {
                  used: await baselineWeight(path.resolve(options.root, config.snapshotDir)),
                  cap: weightCap,
                },
              }
            : {}),
          ...(config.budget?.captures !== undefined
            ? { captures: { used: matrix.captures.length, cap: config.budget.captures } }
            : {}),
        }
      : undefined;

  // The shard split works on the plan this run would capture — after --grep and --changed,
  // so the flags compose: a change-aware run shards the stories it will shoot, rebalanced,
  // while the carried set is every shard's alike and is listed in each shard's summary.
  const runCaptures = options.shard
    ? shardCaptures(planned, options.shard.index, options.shard.total)
    : planned;

  // Captures, not stories: a viewport matrix multiplies, and every cost that matters —
  // runtime, repository weight, review effort — scales with captures (DECISIONS.md §3).
  process.stdout.write(
    headerBlock({
      captures: runCaptures,
      ...(options.grep ? { grep: options.grep } : {}),
      ...(options.shard ? { shard: options.shard } : {}),
      ...(changedText ? { changed: changedText } : {}),
      capture: config.capture,
      configSource: filepath ? displayPath(options.root, filepath) : 'defaults (no config file)',
      storybookDir: config.storybookDir,
      snapshotDir: config.snapshotDir,
      skipped: matrix.skipped,
      unwatched: matrix.unwatched,
      loosened: loosenedStoryIds(planned, config.compare),
      ...(budgetInput ? { budget: budgetInput } : {}),
      ...(config.modes ? { modes: Object.keys(config.modes) } : {}),
    }),
  );

  const createdAt = new Date().toISOString();
  const mode: 'run' | 'update' = options.update ? 'update' : 'run';
  // A shard writes under its own directory beside the output root, so shard artifacts
  // downloaded into one directory land beside each other instead of over each other.
  // Concurrent shards in one checkout still share the generated project, as any two
  // concurrent runs do; CI shards run in separate checkouts.
  const outputDir = options.shard
    ? path.resolve(
        options.root,
        config.outputDir,
        `shard-${options.shard.index}-of-${options.shard.total}`,
      )
    : path.resolve(options.root, config.outputDir);

  // A shard can hold no stories while the plan does not — a branch with fewer stories than
  // shards. Playwright fails an empty test list, so the summary is written here instead: an
  // empty shard is a completed shard, and the merge expects every index to be present.
  if (options.shard && runCaptures.length === 0) {
    return writeEmptyShard({
      root: options.root,
      outputDir,
      snapshotDir: config.snapshotDir,
      mode,
      shard: options.shard,
      createdAt,
      ...(affected ? { affected } : {}),
      ...(carried ? { carried } : {}),
    });
  }

  const server = await serveStatic(storybookDir);
  let project;
  try {
    project = await generateProject({
      root: options.root,
      config,
      captures: runCaptures,
      baseUrl: server.url,
      outputDir,
      reporterPath: path.join(distRoot(), 'reporter.js'),
      ...(axePath ? { axePath } : {}),
      // The retries the reporter sees are the retries the generated project runs with, so
      // it starts region work only on the attempt that can decide a capture.
      ...(options.update ? { mode: 'update' as const } : {}),
      reporterOptions: {
        planPath: path.join(projectDir(options.root), 'plan.json'),
        outputDir,
        snapshotDir: config.snapshotDir,
        snapshotDirAbs: path.resolve(options.root, config.snapshotDir),
        mode,
        ...(options.shard ? { shard: options.shard } : {}),
        retries: options.update ? 0 : config.stabilize.retries,
        platform: process.platform,
        arch: process.arch,
        createdAt,
        ...(affected ? { affected } : {}),
        ...(carried ? { carried } : {}),
      },
    });

    const args = [...(options.passthrough ?? [])];
    if (options.update) args.push('--update-snapshots=all');

    const exit = await runPlaywright({ root: options.root, configPath: project.configPath, args });

    // Update is the one mode that writes baselines, so it is the one that recompresses
    // them: every capture planned above wrote its baseline, and only those files are
    // touched. A capture that failed to write is simply not there to recompress.
    if (options.update && config.compress === 'auto') {
      const written = planned
        .map((capture) => path.join(path.resolve(options.root, config.snapshotDir), capture.snapshotPath))
        .filter((file) => existsSync(file));
      writeRecompressReport(await recompressBaselines({ files: written, root: options.root }));
    }

    return exit;
  } finally {
    await server.close();
    if (project && !options.keep) await project.cleanup();
  }
}
