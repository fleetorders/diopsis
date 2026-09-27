import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { defaultConfig, findConfigFile, loadConfig, supportsTypeStripping } from '../config.ts';
import { resolveMatrix } from '../matrix.ts';
import { readStoryIndex } from '../story-index.ts';

export interface InitOptions {
  root: string;
  /** Overwrite an existing config. */
  force?: boolean;
  /** Set the baselines up for Git LFS instead of plain binary tracking. */
  lfs?: boolean;
}

/**
 * Bytes per full-page capture, used only before any baseline exists.
 *
 * Stated as an assumption rather than a measurement: the real figure depends entirely on the
 * stories, and `doctor` reports it once there is something to weigh.
 */
const ESTIMATED_BYTES_PER_CAPTURE = 80 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The TypeScript form types itself through an `import type`, which Node's type stripping
 * erases along with the annotation. Nothing is imported at runtime, so the config still loads
 * when the package cannot be resolved from here — under `npx`, or before `npm install` has run.
 */
function configSource(typescript: boolean): string {
  const header = typescript
    ? "import type { UserConfig } from 'diopsis';\n\nexport default {"
    : "/** @type {import('diopsis').UserConfig} */\nexport default {";
  const footer = typescript ? '} satisfies UserConfig;' : '};';

  return `${header}
  storybookDir: '${defaultConfig.storybookDir}',
  snapshotDir: '${defaultConfig.snapshotDir}',

  // Every width multiplies the whole story set. Two widths cost half of what four do,
  // in runtime, repository weight and flake surface alike.
  viewports: { default: [320, 1280] },

  // One image name, read by both baseline generation and the CI job.
  image: '${defaultConfig.image}',

  stabilize: {
    freezeClock: '${defaultConfig.stabilize.freezeClock as string}',
    waitForNetworkIdle: true,
    disableAnimations: true,
  },

  // Regions excluded from comparison. Prefer deleting the annotation over masking:
  // the clock is frozen, so anything that only hid a date no longer needs to.
  mask: ['[data-diopsis-ignore]'],

  compare: { threshold: ${defaultConfig.compare.threshold}, maxDiffPixelRatio: ${defaultConfig.compare.maxDiffPixelRatio} },
${footer}
`;
}

export function gitattributesLines(snapshotDir: string, lfs: boolean): string[] {
  const pattern = `${snapshotDir}/**/*.png`;
  return lfs
    ? [`${pattern} filter=lfs diff=lfs merge=lfs -text`]
    : // Unmergeable on purpose: a rebase must conflict loudly rather than quietly
      // produce a PNG that is half of one baseline and half of another.
      [`${pattern} binary -merge -diff`];
}

async function appendLines(file: string, lines: string[], heading: string): Promise<boolean> {
  const existing = existsSync(file) ? await readFile(file, 'utf8') : '';
  const missing = lines.filter((line) => !existing.includes(line));
  if (missing.length === 0) return false;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(file, `${existing}${prefix}\n# ${heading}\n${missing.join('\n')}\n`, 'utf8');
  return true;
}

export function ciRecipe(image: string, snapshotDir: string): string {
  return `# Verify visual regressions in the same image the baselines were generated in.
# The image below must stay identical to \`image\` in diopsis.config — \`diopsis doctor\`
# fails when they drift apart.
# Long builds can split instead: \`npx diopsis run --shard <i>/<n>\` in parallel jobs, then
# \`npx diopsis merge\` over the downloaded shard-* directories for one review.
jobs:
  visual:
    image: ${image}
    script:
      - npm ci
      - npm run build-storybook
      - npx diopsis run
    artifacts:
      when: always
      paths:
        - .diopsis/report.html
        - .diopsis/summary.json
        - .diopsis/test-results
# Baselines live in ${snapshotDir}/ and are reviewed in the merge request.
`;
}

export async function initCommand(options: InitOptions): Promise<number> {
  const existing = findConfigFile(options.root);
  if (existing && !options.force) {
    process.stderr.write(
      `${path.basename(existing)} already exists. Re-run with --force to overwrite it.\n`,
    );
    return 1;
  }

  // With --force, the config being replaced still decides the scaffolding around it: its
  // snapshotDir and outputDir are what .gitattributes and .gitignore must keep guarding,
  // and its widths and image are what the cost table and the CI recipe describe — a
  // re-run must not quietly repoint git settings at the default directories. A config
  // that cannot be loaded falls back to the defaults, said in one line rather than
  // silently.
  let config = defaultConfig;
  const notes: string[] = [];
  if (existing) {
    try {
      config = (await loadConfig(options.root)).config;
    } catch {
      notes.push(
        `Could not load ${path.basename(existing)}; the git settings, cost table and CI ` +
          'recipe below use the defaults.',
      );
    }
  }

  const typescript = supportsTypeStripping();
  const configName = typescript ? 'diopsis.config.ts' : 'diopsis.config.mjs';
  await writeFile(path.join(options.root, configName), configSource(typescript), 'utf8');

  const wroteAttributes = await appendLines(
    path.join(options.root, '.gitattributes'),
    gitattributesLines(config.snapshotDir, options.lfs ?? false),
    'Diopsis baselines: binary, and never auto-merged.',
  );
  const wroteIgnore = await appendLines(
    path.join(options.root, '.gitignore'),
    [`${config.outputDir}/`],
    'Diopsis run output (the report and its artifacts) is not committed.',
  );

  const lines: string[] = [
    '',
    `Wrote ${configName}`,
    ...notes,
    ...(wroteAttributes ? ['Wrote .gitattributes entries for the baselines'] : []),
    ...(wroteIgnore ? [`Wrote .gitignore entry for ${config.outputDir}/`] : []),
    '',
  ];

  if (!typescript) {
    lines.push(
      `Node ${process.versions.node} cannot read a TypeScript config, so the JavaScript form`,
      'was written instead. On Node 22.18 or newer, diopsis.config.ts works with no extra setup.',
      '',
    );
  }

  // The cost of the matrix, before it is inherited rather than chosen.
  const storybookDir = path.resolve(options.root, config.storybookDir);
  if (existsSync(storybookDir)) {
    try {
      const stories = await readStoryIndex(storybookDir);
      lines.push('Cost of the matrix, for this Storybook:', '');
      lines.push('  widths                     captures    estimated weight');
      const sameWidths = (a: number[], b: number[]) =>
        a.length === b.length && a.every((width, i) => width === b[i]);
      const configured = config.viewports.default ?? [];
      // The configured widths are one of the standard rows when they can be; otherwise
      // they get a row of their own, so "(configured)" always marks this project's real
      // widths rather than whichever preset happens to have two entries.
      const rows: number[][] = [[1280], [320, 1280], [320, 768, 1024, 1280]];
      if (!rows.some((widths) => sameWidths(widths, configured))) rows.push(configured);
      const modeNames = config.modes ? Object.keys(config.modes) : [];
      for (const widths of rows) {
        const matrix = resolveMatrix(stories, {
          viewports: { default: widths },
          viewportHeight: config.viewportHeight,
          capture: 'page',
          ...(config.modes ? { modes: config.modes } : {}),
        });
        const label = widths.join(', ').padEnd(25);
        const count = String(matrix.captures.length).padStart(8);
        const weight = formatBytes(matrix.captures.length * ESTIMATED_BYTES_PER_CAPTURE);
        lines.push(
          `  ${label}${count}    ${weight}${sameWidths(widths, configured) ? '   (configured)' : ''}`,
        );
      }
      lines.push(
        '',
        `  ${stories.length} stories. Weight assumes ${formatBytes(ESTIMATED_BYTES_PER_CAPTURE)} per capture;`,
        '  `diopsis doctor` reports the real figure once baselines exist. Every intentional',
        '  change adds another full set to history, permanently.',
        // The table's rows stay widths, as ever; with modes configured the counts above are
        // the multiplied ones, so the note says what the multiplier is.
        ...(modeNames.length
          ? [
              `  Counts include the configured modes (${modeNames.join(', ')}): every capture`,
              '  runs once more per mode, with its own baselines.',
            ]
          : []),
        '',
      );
    } catch {
      lines.push(`Could not read the story index in ${config.storybookDir}.`, '');
    }
  } else {
    lines.push(
      `No build at ${config.storybookDir} yet, so the capture count could not be`,
      'estimated. Build the Storybook and run `diopsis doctor` to see it.',
      '',
    );
  }

  lines.push(
    'CI recipe:',
    '',
    ...ciRecipe(config.image, config.snapshotDir)
      .trimEnd()
      .split('\n')
      .map((line) => `  ${line}`),
    '',
    'Next: build your Storybook, then `diopsis update` to generate baselines.',
    '',
  );

  process.stdout.write(lines.join('\n'));
  return 0;
}
