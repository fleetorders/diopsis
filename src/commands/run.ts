import { existsSync } from 'node:fs';
import path from 'node:path';

import { baselineWeight } from '../baselines.ts';
import { formatBytes, loadConfig, parseSize } from '../config.ts';
import {
  loosenedStoryIds,
  platformToken,
  resolveMatrix,
  type Capture,
  type ResolvedMatrix,
} from '../matrix.ts';
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

  return (
    `${headerLine(input.captures, input.grep)}\n` +
    `  config    ${input.configSource}\n` +
    `  storybook ${input.storybookDir}\n` +
    `  baselines ${input.snapshotDir}\n` +
    budgetLines +
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

  if (captures.length === 0) {
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

  // Captures, not stories: a viewport matrix multiplies, and every cost that matters —
  // runtime, repository weight, review effort — scales with captures (DECISIONS.md §3).
  process.stdout.write(
    headerBlock({
      captures,
      ...(options.grep ? { grep: options.grep } : {}),
      capture: config.capture,
      configSource: filepath ? path.relative(options.root, filepath) : 'defaults (no config file)',
      storybookDir: config.storybookDir,
      snapshotDir: config.snapshotDir,
      skipped: matrix.skipped,
      unwatched: matrix.unwatched,
      loosened: loosenedStoryIds(captures, config.compare),
      ...(budgetInput ? { budget: budgetInput } : {}),
      ...(config.modes ? { modes: Object.keys(config.modes) } : {}),
    }),
  );

  const server = await serveStatic(storybookDir);
  let project;
  try {
    project = await generateProject({
      root: options.root,
      config,
      captures,
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
