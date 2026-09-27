import { existsSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../config.ts';
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
  storybookDir: string;
  snapshotDir: string;
  skipped: string[];
  unwatched: string[];
  loosened: string[];
}): string {
  return (
    `${headerLine(input.captures, input.grep)}\n` +
    `  config    ${input.configSource}\n` +
    `  storybook ${input.storybookDir}\n` +
    `  baselines ${input.snapshotDir}\n` +
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

  // Captures, not stories: a viewport matrix multiplies, and every cost that matters —
  // runtime, repository weight, review effort — scales with captures (DECISIONS.md §3).
  process.stdout.write(
    headerBlock({
      captures,
      ...(options.grep ? { grep: options.grep } : {}),
      configSource: filepath ? path.relative(options.root, filepath) : 'defaults (no config file)',
      storybookDir: config.storybookDir,
      snapshotDir: config.snapshotDir,
      skipped: matrix.skipped,
      unwatched: matrix.unwatched,
      loosened: loosenedStoryIds(captures, config.compare),
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
      reporterOptions: {
        planPath: path.join(projectDir(options.root), 'plan.json'),
        outputDir: path.resolve(options.root, config.outputDir),
        snapshotDir: config.snapshotDir,
        snapshotDirAbs: path.resolve(options.root, config.snapshotDir),
        mode: options.update ? 'update' : 'run',
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
