import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { findConfigFile, loadConfig, supportsTypeStripping } from '../config.ts';
import { platformToken, resolveMatrix } from '../matrix.ts';
import { readStoryIndex } from '../story-index.ts';

export type Level = 'ok' | 'warn' | 'fail';

export interface Check {
  level: Level;
  title: string;
  detail?: string;
}

export interface DoctorOptions {
  root: string;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
      expected = new Set(matrix.captures.map((capture) => capture.snapshotPath));
      checks.push({
        level: 'ok',
        title: `${stories.length} stories → ${captureCount} captures`,
        detail:
          `Widths ${Object.entries(config.viewports)
            .map(([name, widths]) => `${name}: ${widths.join(', ')}`)
            .join(' · ')}` +
          (matrix.skipped.length ? ` · ${matrix.skipped.length} skipped` : ''),
      });
      if (matrix.unwatched.length > 0) {
        checks.push({
          level: 'warn',
          title: `${matrix.unwatched.length} stories are captured at no width`,
          detail:
            'viewports.default is empty, so only stories tagged with a width or a viewport ' +
            'set are captured. Give default its widths back if the others should be watched.',
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

  // The baseline set: weight, platform suffixes, orphans.
  if (!existsSync(snapshotDir)) {
    checks.push({
      level: 'warn',
      title: `No baselines yet at ${config.snapshotDir}`,
      detail: 'Generate them with `diopsis update`.',
    });
  } else {
    const files = (await walk(snapshotDir)).filter((file) => file.endsWith('.png'));
    let bytes = 0;
    for (const file of files) bytes += (await stat(file)).size;

    checks.push({
      level: 'ok',
      title: `${files.length} baselines, ${formatBytes(bytes)}`,
      detail:
        'Every intentional change adds another set to history permanently — this figure ' +
        'only grows.',
    });

    const relative = files.map((file) => path.relative(snapshotDir, file).split(path.sep).join('/'));
    const unsuffixed = relative.filter((file) => !/-[a-z0-9]+-[a-z0-9]+\.png$/.test(file));
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
              `e.g. ${unsuffixed[0]} — a run on another platform would overwrite these ` +
              'rather than compare against them.',
          },
    );

    if (expected.size > 0) {
      const orphans = relative.filter((file) => !expected.has(file));
      const platforms = new Set(
        relative
          .map((file) => /-([a-z0-9]+-[a-z0-9]+)\.png$/.exec(file)?.[1])
          .filter((token): token is string => Boolean(token)),
      );
      // Only this platform's set can be judged orphaned; other platforms' baselines are
      // expected to be here and are not in this run's capture list.
      const localOrphans = orphans.filter((file) => file.includes(platformToken()));
      checks.push(
        localOrphans.length === 0
          ? { level: 'ok', title: 'No orphaned baselines for this platform' }
          : {
              level: 'warn',
              title: `${localOrphans.length} baselines belong to stories that no longer exist`,
              detail: `e.g. ${localOrphans[0]} — delete them so the set stops carrying dead weight.`,
            },
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
  const ignoresBaselines = ignore
    .split('\n')
    .some((line) => line.trim() === `${config.snapshotDir}/` || line.trim() === config.snapshotDir);
  if (ignoresBaselines) {
    checks.push({
      level: 'fail',
      title: `.gitignore excludes ${config.snapshotDir}`,
      detail: 'The baselines are the point — ignored, every run compares against nothing.',
    });
  }
  if (!ignore.includes(config.outputDir)) {
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
  const lines = ['', 'Diopsis doctor', ''];
  for (const check of checks) {
    const symbol = check.level === 'ok' ? '·' : check.level === 'warn' ? '!' : '×';
    lines.push(`  ${symbol} ${check.title}`);
    if (check.detail) lines.push(`      ${check.detail}`);
  }

  const failures = checks.filter((check) => check.level === 'fail').length;
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
