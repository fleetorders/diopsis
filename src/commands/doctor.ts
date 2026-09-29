import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  expectedBaselines,
  orphanedBaselines,
  renameHints,
  walkBaselines,
} from '../baselines.ts';
import { oxipngInstalled } from '../compress.ts';
import { findConfigFile, formatBytes, loadConfig, parseSize, supportsTypeStripping } from '../config.ts';
import { gitIgnoreRule, gitIgnores, isGitRepo } from '../git.ts';
import { loosenedStoryIds, platformToken, resolveMatrix } from '../matrix.ts';
import { readStoryIndex } from '../story-index.ts';

export type Level = 'ok' | 'warn' | 'fail';

export interface Check {
  level: Level;
  title: string;
  detail?: string;
  /** On the story-count check only: the numbers its title spells out, so a script can
   *  assert them without matching display text. */
  counts?: { stories: number; captures: number };
}

export interface DoctorOptions {
  root: string;
  /** Print the checks as JSON to stdout, with no prose around them. */
  json?: boolean;
}

/** Any `data-…-ignore` attribute that is not ours — an unfinished migration (D-008). */
const FOREIGN_IGNORE = /data-([a-z0-9-]+)-ignore\b/g;

export function findForeignIgnoreAttributes(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(FOREIGN_IGNORE)) {
    const vendor = match[1];
    if (vendor && vendor !== 'diopsis') found.add(`data-${vendor}-ignore`);
  }
  return [...found].sort();
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/** Fixed-name CI files that can name the job's container, one per host. */
const CI_FILES: readonly string[] = [
  '.gitlab-ci.yml',
  '.circleci/config.yml',
  'bitbucket-pipelines.yml',
  'azure-pipelines.yml',
];

/** A Playwright image reference as a CI file writes it, tag or digest included. */
const PLAYWRIGHT_IMAGE = /mcr\.microsoft\.com\/playwright[^\s'"`]+/g;

/**
 * Every Playwright image a CI file names, with the file it came from. GitHub keeps its
 * workflows in a directory (both spellings of the extension); every other host uses one
 * fixed filename at the root.
 */
export async function findCiImageReferences(
  root: string,
): Promise<Array<{ file: string; image: string }>> {
  const candidates: string[] = [];
  try {
    for (const entry of await readdir(path.join(root, '.github', 'workflows'))) {
      if (entry.endsWith('.yml') || entry.endsWith('.yaml')) {
        candidates.push(path.join('.github', 'workflows', entry));
      }
    }
  } catch {
    // No workflows directory; the fixed-name files below still get their chance.
  }
  candidates.push(...CI_FILES);

  const found: Array<{ file: string; image: string }> = [];
  for (const candidate of candidates) {
    let text: string;
    try {
      text = await readFile(path.join(root, candidate), 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(PLAYWRIGHT_IMAGE)) {
      found.push({ file: candidate.split(path.sep).join('/'), image: match[0] });
    }
  }
  return found;
}

/**
 * The @playwright/test version installed for this project, when there is one. Resolved
 * through Node's own resolution so hoisted and nested installs are both found; a peer
 * dependency that is not installed here is simply nothing to compare against.
 */
export function installedPlaywrightVersion(root: string): string | undefined {
  try {
    const require = createRequire(path.join(root, 'package.json'));
    const manifest = JSON.parse(
      readFileSync(require.resolve('@playwright/test/package.json'), 'utf8'),
    ) as { version?: string };
    return manifest.version;
  } catch {
    return undefined;
  }
}

/**
 * Audit a setup for the misconfigurations that silently invalidate a baseline set.
 *
 * This is the command that turns the guarantees in the design into guardrails rather than
 * documentation (DECISIONS.md §6): each of these costs a run, or a false green, when missed.
 */
export async function runChecks(options: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const configPath = findConfigFile(options.root);

  if (!configPath) {
    checks.push({
      level: 'warn',
      title: 'No config file',
      detail: 'Running on defaults. `diopsis init` writes one.',
    });
  } else if (
    (configPath.endsWith('.ts') || configPath.endsWith('.mts')) &&
    !supportsTypeStripping()
  ) {
    checks.push({
      level: 'fail',
      title: `${path.basename(configPath)} cannot be read on Node ${process.versions.node}`,
      detail: 'A TypeScript config needs Node 22.18 or newer, or rename it to .mjs.',
    });
    return checks;
  }

  const { config } = await loadConfig(options.root);
  const storybookDir = path.resolve(options.root, config.storybookDir);
  const snapshotDir = path.resolve(options.root, config.snapshotDir);

  checks.push(
    config.image
      ? {
          level: 'ok',
          title: 'Baseline image is pinned',
          detail: `${config.image} — the CI job must name this exact image.`,
        }
      : {
          level: 'fail',
          title: 'No image pinned',
          detail: 'Without one, baselines and CI can disagree with nothing to catch it.',
        },
  );

  if (config.image) {
    // The CI recipe `init` prints promises this check: a pinned image is only a guarantee
    // while CI runs it, and drift surfaces as every baseline differing at once.
    const references = await findCiImageReferences(options.root);
    if (references.length === 0) {
      checks.push({
        level: 'ok',
        title: 'No CI file names a Playwright image',
        detail: `Make sure CI runs in ${config.image}.`,
      });
    } else {
      const drifting = references.filter((reference) => reference.image !== config.image);
      checks.push(
        drifting.length === 0
          ? {
              level: 'ok',
              title: 'CI runs the pinned image',
              detail: [...new Set(references.map((reference) => reference.file))].join(', '),
            }
          : {
              level: 'fail',
              title: 'CI runs a different Playwright image than the config pins',
              detail:
                drifting
                  .map((d) => `${d.file} runs ${d.image}; the config pins ${config.image}.`)
                  .join(' ') +
                ' Screenshots from a different browser build differ, so every baseline would ' +
                'diff at once.',
            },
      );
    }

    // The image carries the browser build CI captures in; the installed @playwright/test
    // decides the one this machine captures in. When they differ, local baselines and CI's
    // cannot match, whatever the config promises.
    const imageVersion = /:v(\d+\.\d+\.\d+)/.exec(config.image)?.[1];
    const installed = installedPlaywrightVersion(options.root);
    if (imageVersion && installed && installed !== imageVersion) {
      checks.push({
        level: 'warn',
        title: `Installed @playwright/test ${installed} does not match the pinned image`,
        detail:
          `${config.image} carries Playwright ${imageVersion}. Screenshots from a different ` +
          'browser build differ, so align the dependency and the image, then regenerate the ' +
          'baselines.',
      });
    }
  }

  // Storybook build and the capture count.
  let captureCount = 0;
  let expected = new Set<string>();
  if (!existsSync(storybookDir)) {
    checks.push({
      level: 'warn',
      title: `No Storybook build at ${config.storybookDir}`,
      detail: 'Story-level checks were skipped.',
    });
  } else {
    try {
      const stories = await readStoryIndex(storybookDir);
      const matrix = resolveMatrix(stories, config);
      captureCount = matrix.captures.length;
      // Doctor judges only this platform's set; every other platform's baselines are
      // expected to be here without being in this run's capture list.
      expected = expectedBaselines(matrix.captures, [platformToken()]);
      checks.push({
        level: 'ok',
        title: `${stories.length} stories → ${captureCount} captures`,
        counts: { stories: stories.length, captures: captureCount },
        detail:
          `Widths ${Object.entries(config.viewports)
            .map(([name, widths]) => `${name}: ${widths.join(', ')}`)
            .join(' · ')}` +
          (matrix.skipped.length ? ` · ${matrix.skipped.length} skipped` : ''),
      });
      const budgetCaptures = config.budget?.captures;
      if (budgetCaptures !== undefined) {
        const count = matrix.captures.length;
        checks.push(
          count > budgetCaptures
            ? {
                level: 'fail',
                title: `Matrix produces ${count} captures, over the ${budgetCaptures} budget`,
                detail:
                  'Every capture is one baseline, one comparison and one review row — drop ' +
                  'widths or stories to bring the set back inside it.',
              }
            : count >= 0.9 * budgetCaptures
              ? {
                  level: 'warn',
                  title: `Matrix produces ${count} captures, within 10% of the ${budgetCaptures} budget`,
                }
              : {
                  level: 'ok',
                  title: `Matrix produces ${count} captures, under the ${budgetCaptures} budget`,
                },
        );
      }
      if (matrix.unwatched.length > 0) {
        checks.push({
          level: 'warn',
          title: `${matrix.unwatched.length} stories are captured at no width`,
          detail:
            'viewports.default is empty, so only stories tagged with a width or a viewport ' +
            'set are captured. Give default its widths back if the others should be watched.',
        });
      }

      const loosened = loosenedStoryIds(matrix.captures, config.compare);
      if (loosened.length > 0) {
        const shown = loosened.slice(0, 10);
        const rest = loosened.length - shown.length;
        checks.push({
          level: 'warn',
          title: `${loosened.length} ${loosened.length === 1 ? 'story compares' : 'stories compare'} more loosely than the config`,
          detail:
            `${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''} — ` +
            'diopsis:threshold / max-diff-* tags widened these beyond compare in the config.',
        });
      }

      for (const warning of matrix.warnings) {
        checks.push({ level: 'warn', title: 'Unrecognised story tag', detail: warning });
      }

      const build = await walk(storybookDir);
      const foreign = new Set<string>();
      for (const file of build) {
        if (!/\.(js|mjs|html)$/.test(file)) continue;
        for (const attribute of findForeignIgnoreAttributes(await readFile(file, 'utf8'))) {
          foreign.add(attribute);
        }
      }
      if (foreign.size > 0) {
        checks.push({
          level: 'warn',
          title: 'Another tool’s ignore attribute is still in the build',
          detail:
            `${[...foreign].join(', ')} — Diopsis reads only data-diopsis-ignore. ` +
            'Because the clock is frozen, annotations that only hid a date can be deleted ' +
            'rather than renamed.',
        });
      }
    } catch (error) {
      checks.push({
        level: 'fail',
        title: 'Story index could not be read',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The baseline set: weight, budget, platform suffixes, orphans.
  if (!existsSync(snapshotDir)) {
    checks.push({
      level: 'warn',
      title: `No baselines yet at ${config.snapshotDir}`,
      detail: 'Generate them with `diopsis update`.',
    });
  } else {
    const files = await walkBaselines(snapshotDir);
    const bytes = files.reduce((total, file) => total + file.bytes, 0);
    const localBytes = files
      .filter((file) => file.platform === platformToken())
      .reduce((total, file) => total + file.bytes, 0);

    checks.push({
      level: 'ok',
      title: `${files.length} baselines, ${formatBytes(bytes)}`,
      detail:
        `${formatBytes(localBytes)} on this platform (${platformToken()}), ` +
        `${formatBytes(bytes)} in total — every intentional change adds another set to ` +
        'history permanently, so the total only grows.',
    });

    const budgetWeight =
      config.budget?.weight !== undefined ? parseSize(config.budget.weight) : undefined;
    if (budgetWeight !== undefined) {
      checks.push(
        bytes > budgetWeight
          ? {
              level: 'fail',
              title: `Baselines weigh ${formatBytes(bytes)}, over the ${formatBytes(budgetWeight)} budget`,
              detail:
                `${formatBytes(localBytes)} of it is this platform's set — ` +
                '`diopsis prune` deletes what no capture would write; fewer widths or ' +
                'stories cut the rest.',
            }
          : bytes >= 0.9 * budgetWeight
            ? {
                level: 'warn',
                title:
                  `Baselines weigh ${formatBytes(bytes)}, within 10% of the ` +
                  `${formatBytes(budgetWeight)} budget`,
                detail: `${formatBytes(localBytes)} of it is this platform's set.`,
              }
            : {
                level: 'ok',
                title: `Baselines weigh ${formatBytes(bytes)} of the ${formatBytes(budgetWeight)} budget`,
              },
      );
    }

    const unsuffixed = files.filter((file) => file.platform === undefined);
    checks.push(
      unsuffixed.length === 0
        ? {
            level: 'ok',
            title: 'Every baseline carries a platform and architecture',
            detail: `This machine writes ${platformToken()}.`,
          }
        : {
            level: 'fail',
            title: `${unsuffixed.length} baselines have no platform suffix`,
            detail:
              `e.g. ${unsuffixed[0]?.relative} — a run on another platform would overwrite ` +
              'these rather than compare against them.',
          },
    );

    if (expected.size > 0) {
      const orphans = orphanedBaselines(files, expected).filter(
        (file) => file.platform === platformToken(),
      );
      const hints = await renameHints(
        orphans,
        snapshotDir,
        path.resolve(options.root, config.outputDir),
      );
      const shown = [...hints.values()]
        .slice(0, 3)
        .map((hint) => `looks renamed: ${hint.from} → ${hint.to}`);
      checks.push(
        orphans.length === 0
          ? { level: 'ok', title: 'No orphaned baselines for this platform' }
          : {
              // A mode or state baseline names a mode the config no longer carries, or a
              // state tag a story no longer has, as readily as a story the index no longer
              // lists; all are dead weight until deleted.
              level: 'warn',
              title:
                `${orphans.length} ${orphans.length === 1 ? 'baseline belongs' : 'baselines belong'} ` +
                `to ${orphans.length === 1 ? 'a story, mode or state' : 'stories, modes or states'} ` +
                'that no longer exist',
              detail:
                `e.g. ${orphans[0]?.relative} — run \`diopsis prune\` to delete them.` +
                (shown.length
                  ? ` ${shown.join('; ')}` +
                    (hints.size > 3 ? ` (+${hints.size - 3} more)` : '') +
                    '.'
                  : ''),
            },
      );
      const platforms = new Set(
        files
          .map((file) => file.platform)
          .filter((token): token is string => Boolean(token)),
      );
      if (platforms.size > 1) {
        checks.push({
          level: 'ok',
          title: `Baseline sets for ${platforms.size} platforms`,
          detail: [...platforms].sort().join(', '),
        });
      }
    }
  }

  // Compression asks for a tool the setup was never checked for, so this is where its
  // absence should surface — before an update spends a run writing uncompressed baselines.
  if (config.compress === 'auto' && !oxipngInstalled()) {
    checks.push({
      level: 'warn',
      title: 'compress is auto, but oxipng is not installed',
      detail: 'Baselines are written uncompressed (see https://github.com/oxipng/oxipng).',
    });
  }

  // Git hygiene.
  const attributesPath = path.join(options.root, '.gitattributes');
  const attributes = existsSync(attributesPath) ? await readFile(attributesPath, 'utf8') : '';
  const guarded = attributes.includes(config.snapshotDir) && /(-merge|filter=lfs)/.test(attributes);
  checks.push(
    guarded
      ? { level: 'ok', title: 'Baselines are marked unmergeable in .gitattributes' }
      : {
          level: 'warn',
          title: 'Baselines are not marked unmergeable',
          detail:
            `Add "${config.snapshotDir}/**/*.png binary -merge -diff" so a rebase conflicts ` +
            'loudly instead of producing a corrupt PNG.',
        },
  );

  const ignorePath = path.join(options.root, '.gitignore');
  const ignore = existsSync(ignorePath) ? await readFile(ignorePath, 'utf8') : '';
  // Inside a repository, git's own rules decide — `/__screenshots__` and
  // `**/__screenshots__/` both ignore the baselines while matching no exact line a
  // .gitignore string scan compares. The probe is a file inside the directory, because a
  // pattern can target a directory's contents while missing its name. Outside a
  // repository, or when git could not answer, the exact-line check stands.
  const inRepo = isGitRepo(options.root);
  const byGit = (dir: string): boolean | undefined =>
    inRepo ? gitIgnores(options.root, path.join(dir, 'probe.png')) : undefined;
  // The baselines' probe asks for the rule itself, not only the verdict: the file, the
  // line and the pattern turn "ignored" into an address a fix can go to, and a rule that
  // lives in a parent directory's file names that file as one.
  const baselineRule = inRepo
    ? gitIgnoreRule(options.root, path.join(snapshotDir, 'probe.png'))
    : undefined;
  const ignoresBaselines =
    (baselineRule === undefined ? undefined : baselineRule !== false) ??
    ignore
      .split('\n')
      .some((line) => line.trim() === `${config.snapshotDir}/` || line.trim() === config.snapshotDir);
  if (ignoresBaselines) {
    checks.push({
      level: 'fail',
      title: `.gitignore excludes ${config.snapshotDir}`,
      detail: baselineRule
        ? 'The baselines are the point — ignored by ' +
          `${baselineRule.source} line ${baselineRule.line} (\`${baselineRule.pattern}\`), ` +
          'every run compares against nothing.'
        : 'The baselines are the point — ignored, every run compares against nothing.',
    });
  }
  const ignoresOutput =
    byGit(path.resolve(options.root, config.outputDir)) ?? ignore.includes(config.outputDir);
  if (!ignoresOutput) {
    checks.push({
      level: 'warn',
      title: `${config.outputDir}/ is not ignored`,
      detail: 'Run output would be committed alongside the baselines.',
    });
  }

  return checks;
}

export async function doctorCommand(options: DoctorOptions): Promise<number> {
  const checks = await runChecks(options);
  const failures = checks.filter((check) => check.level === 'fail').length;

  if (options.json) {
    // The JSON document is the whole of stdout — a caller piping it to jq or a CI script
    // must not have to strip a prose report off it first. The exit code still says
    // pass/fail, so a plain `diopsis doctor` and a scripted one disagree on nothing.
    const payload = {
      diopsis: 1,
      ok: failures === 0,
      checks: checks.map(({ level, title, detail, counts }) => {
        const entry: { level: Level; title: string; detail?: string; counts?: Check['counts'] } = {
          level,
          title,
        };
        if (detail !== undefined) entry.detail = detail;
        if (counts !== undefined) entry.counts = counts;
        return entry;
      }),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return failures > 0 ? 1 : 0;
  }

  const lines = ['', 'Diopsis doctor', ''];
  for (const check of checks) {
    const symbol = check.level === 'ok' ? '·' : check.level === 'warn' ? '!' : '×';
    lines.push(`  ${symbol} ${check.title}`);
    if (check.detail) lines.push(`      ${check.detail}`);
  }

  const warnings = checks.filter((check) => check.level === 'warn').length;
  lines.push(
    '',
    failures > 0
      ? `${failures} problem${failures === 1 ? '' : 's'} to fix` +
          (warnings ? `, ${warnings} worth a look` : '')
      : warnings > 0
        ? `Nothing broken; ${warnings} worth a look.`
        : 'Everything checks out.',
    '',
  );

  process.stdout.write(lines.join('\n'));
  return failures > 0 ? 1 : 0;
}
