import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AccessibilityMode } from './accessibility.ts';

/**
 * Stabilization defaults. Every one of these is on by default: a guarantee that has to be
 * switched on is a guarantee most suites never get (DECISIONS.md §3).
 */
export interface StabilizeOptions {
  /** Fixed wall-clock time, ISO-8601. `false` leaves the clock alone. */
  freezeClock: string | false;
  /** Wait for the network to go idle before capturing. */
  waitForNetworkIdle: boolean;
  /** Zero out CSS animations, transitions and scroll behaviour. */
  disableAnimations: boolean;
  /** Wait for `document.fonts.ready`. */
  waitForFonts: boolean;
  /** Wait for every `<img>` to finish decoding. */
  waitForImages: boolean;
  /** Wait for common loading-state markers to disappear. */
  waitForLoadingStates: boolean;
  /** Wait for the story's play function, when it has one, to finish before capturing. */
  waitForPlay: boolean;
  /** Ceiling, in ms, for the whole stabilization sequence. */
  settleTimeout: number;
  /**
   * Re-takes of a capture that differs. Playwright already waits for two identical
   * consecutive screenshots inside one page, so flake that survives comes from differences
   * between page loads — a retry takes the capture from a fresh page, and a difference that
   * vanishes is reported as unstable rather than as a change.
   */
  retries: number;
}

export interface CompareOptions {
  /** Per-pixel colour distance tolerance, 0–1. */
  threshold: number;
  /** Share of differing pixels tolerated before a capture counts as changed. */
  maxDiffPixelRatio: number;
  /**
   * Differing-pixel count tolerated before a capture counts as changed. Unset means the
   * knob is off; when both this and `maxDiffPixelRatio` are set, Playwright applies the
   * stricter of the two.
   */
  maxDiffPixels?: number;
}

export interface DiopsisConfig {
  /** Directory holding the built static Storybook. */
  storybookDir: string;
  /** Directory the baselines are committed to. */
  snapshotDir: string;
  /**
   * Named sets of viewport widths. `default` applies to every story that carries no
   * `diopsis:` tag; other names are selected per story by a `diopsis:<name>` tag.
   */
  viewports: Record<string, number[]>;
  /**
   * Named sets of Storybook globals — a dark theme, a right-to-left locale — each captured
   * beside the base capture with its own baselines. A story restricts itself with
   * `diopsis:modes=<a>,<b>`; `diopsis:modes=none` leaves the base capture only.
   */
  modes?: Record<string, Record<string, string>>;
  /** Viewport height. Captures are full-page, so this sets the fold, not the crop. */
  viewportHeight: number;
  /** Capture the whole scrollable page rather than the viewport. */
  fullPage: boolean;
  /**
   * What each capture frames: the whole page, or the rendered component alone. Per-story
   * `diopsis:component` / `diopsis:page` tags override it for one story.
   */
  capture: 'page' | 'component';
  /** The one image name that both baseline generation and CI verification read. */
  image: string;
  stabilize: StabilizeOptions;
  /** Selectors painted over before comparison. */
  mask: string[];
  compare: CompareOptions;
  /**
   * Ceilings on the baseline set's cost, so growth is a decision someone sees rather than
   * a slow accumulation. `weight` caps the bytes under `snapshotDir` — a number of bytes,
   * or text like "800 KB" / "25 MB"; `captures` caps the size of the matrix.
   */
  budget?: { weight?: string | number; captures?: number };
  /**
   * Lossless recompression of every baseline `update` and `accept` write, by the oxipng
   * executable when it is installed. `"off"` leaves each baseline exactly as the browser
   * encoded it.
   */
  compress: "off" | "auto";
  /** `'all'` in v1; `'auto'` (change-aware capture) lands in v2 — DECISIONS.md §4. */
  affected: 'all' | 'auto';
  /**
   * Audits each story's render with the tested project's axe-core and reports the
   * findings beside the pixels. `'off'` never audits; `'report'` never touches the exit
   * code; `'fail'` fails a run with new findings like a change (DECISIONS.md D-042).
   */
  accessibility: AccessibilityMode;
  /** Per-capture timeout in ms. */
  timeout: number;
  /**
   * Parallel workers. Left to Playwright's default when unset; Playwright also accepts a
   * percentage of the machine's CPUs, written like "50%".
   */
  workers?: number | string;
  /** Where the report and summary are written. */
  outputDir: string;
}

export type UserConfig = {
  [K in keyof DiopsisConfig]?: K extends 'stabilize'
    ? Partial<StabilizeOptions>
    : K extends 'compare'
      ? Partial<CompareOptions>
      : DiopsisConfig[K];
};

export const defaultConfig: DiopsisConfig = {
  storybookDir: 'storybook-static',
  snapshotDir: '__screenshots__',
  viewports: { default: [320, 1280] },
  viewportHeight: 900,
  fullPage: true,
  capture: 'page',
  image: 'mcr.microsoft.com/playwright:v1.62.1-jammy',
  stabilize: {
    freezeClock: '2026-01-15T12:00:00Z',
    waitForNetworkIdle: true,
    disableAnimations: true,
    waitForFonts: true,
    waitForImages: true,
    waitForLoadingStates: true,
    waitForPlay: true,
    settleTimeout: 15_000,
    retries: 1,
  },
  mask: ['[data-diopsis-ignore]'],
  compare: { threshold: 0.2, maxDiffPixelRatio: 0.001 },
  compress: 'off',
  affected: 'all',
  accessibility: 'off',
  timeout: 30_000,
  outputDir: '.diopsis',
};

/** Identity helper that gives a config file full type checking and completion. */
export function defineConfig(config: UserConfig): UserConfig {
  return config;
}

export function resolveConfig(user: UserConfig = {}): DiopsisConfig {
  return {
    ...defaultConfig,
    ...user,
    viewports: user.viewports ?? defaultConfig.viewports,
    stabilize: { ...defaultConfig.stabilize, ...user.stabilize },
    compare: { ...defaultConfig.compare, ...user.compare },
    ...(user.budget ? { budget: { ...user.budget } } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON formatting keeps strings quoted and numbers bare — the value as it was written. */
function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function isPositiveIntegers(value: unknown): boolean {
  return Array.isArray(value) && value.every((width) => Number.isInteger(width) && width > 0);
}

function isUnitInterval(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Bytes in each unit a size may name. A kilobyte is 1024 bytes, as written. */
const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

/**
 * A size as the budget accepts it: a number of bytes, or text like "800 KB" / "25 MB" —
 * case-insensitive, optional space, binary multiples. Undefined when the value names no
 * positive size, so `validateConfig` can report the key rather than the parse failing.
 */
export function parseSize(value: string | number): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(value);
  if (!match) return undefined;
  const bytes = Number(match[1]) * (SIZE_UNITS[(match[2] ?? 'b').toLowerCase()] ?? 0);
  return bytes > 0 ? bytes : undefined;
}

/**
 * Bytes at the scale a person reads: "812 B", "800 KB", "31.2 MB". The one formatter for
 * every weight the tool reports, so two surfaces never show one set of bytes as two
 * different numbers.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

/**
 * Check a merged config against everything the rest of the tool assumes about it. Every
 * problem is returned, not just the first, and each message names the key and the bad
 * value so the offending line is findable without reading this source. `loadConfig` turns
 * the list into one error prefixed with the config file name.
 */
export function validateConfig(config: DiopsisConfig): string[] {
  const problems: string[] = [];

  if (!isPlainObject(config.viewports)) {
    problems.push(`viewports must be an object of named width sets (got ${show(config.viewports)})`);
  } else {
    if (!('default' in config.viewports)) {
      problems.push(
        'viewports must define a "default" set — an explicit empty array means only ' +
          'tagged stories are captured',
      );
    }
    for (const [name, widths] of Object.entries(config.viewports)) {
      if (!isPositiveIntegers(widths)) {
        problems.push(
          `viewports.${name} must be an array of positive integer widths (got ${show(widths)})`,
        );
      }
    }
  }

  // A mode name becomes part of a baseline filename and a URL parameter, so both have to be
  // safe by construction rather than escaped on use.
  if (config.modes !== undefined) {
    if (!isPlainObject(config.modes)) {
      problems.push(`modes must be an object of named globals sets (got ${show(config.modes)})`);
    } else {
      for (const [name, globals] of Object.entries(config.modes)) {
        if (!/^[a-z0-9-]+$/.test(name)) {
          problems.push(
            `modes.${name} is not a valid mode name — lowercase letters, digits and dashes only`,
          );
          continue;
        }
        if (!isPlainObject(globals)) {
          problems.push(`modes.${name} must be an object of globals (got ${show(globals)})`);
          continue;
        }
        for (const [key, value] of Object.entries(globals)) {
          if (!key || /[:;]/.test(key)) {
            problems.push(
              `modes.${name}: globals keys must be non-empty and free of ":" and ";" ` +
                `(got key ${show(key)})`,
            );
          }
          if (typeof value !== 'string' || !value || /[:;]/.test(value)) {
            problems.push(
              `modes.${name}.${key} must be a non-empty string without ":" or ";" ` +
                `(got ${show(value)})`,
            );
          }
        }
      }
    }
  }

  // A budget caps what the viewports and modes below it multiply into, so it is judged
  // right beside them.
  if (config.budget !== undefined) {
    if (!isPlainObject(config.budget)) {
      problems.push(`budget must be an object (got ${show(config.budget)})`);
    } else {
      const { weight, captures } = config.budget;
      if (weight !== undefined && parseSize(weight) === undefined) {
        problems.push(
          `budget.weight must be a number of bytes or a size like "800 KB" / "25 MB" ` +
            `(got ${show(weight)})`,
        );
      }
      if (captures !== undefined && !(Number.isInteger(captures) && captures > 0)) {
        problems.push(`budget.captures must be a positive integer (got ${show(captures)})`);
      }
    }
  }

  if (config.compress !== 'off' && config.compress !== 'auto') {
    problems.push(`compress must be "off" or "auto" (got ${show(config.compress)})`);
  }

  if (!Number.isInteger(config.viewportHeight) || config.viewportHeight <= 0) {
    problems.push(`viewportHeight must be a positive integer (got ${show(config.viewportHeight)})`);
  }
  if (!isUnitInterval(config.compare.threshold)) {
    problems.push(
      `compare.threshold must be a number between 0 and 1 (got ${show(config.compare.threshold)})`,
    );
  }
  if (!isUnitInterval(config.compare.maxDiffPixelRatio)) {
    problems.push(
      `compare.maxDiffPixelRatio must be a number between 0 and 1 ` +
        `(got ${show(config.compare.maxDiffPixelRatio)})`,
    );
  }
  if (
    config.compare.maxDiffPixels !== undefined &&
    !(Number.isInteger(config.compare.maxDiffPixels) && config.compare.maxDiffPixels >= 0)
  ) {
    problems.push(
      `compare.maxDiffPixels must be a non-negative integer ` +
        `(got ${show(config.compare.maxDiffPixels)})`,
    );
  }
  if (typeof config.timeout !== 'number' || !Number.isFinite(config.timeout) || config.timeout <= 0) {
    problems.push(`timeout must be a positive number (got ${show(config.timeout)})`);
  }
  const settleTimeout = config.stabilize.settleTimeout;
  if (typeof settleTimeout !== 'number' || !Number.isFinite(settleTimeout) || settleTimeout <= 0) {
    problems.push(`stabilize.settleTimeout must be a positive number (got ${show(settleTimeout)})`);
  }
  if (typeof config.stabilize.waitForPlay !== 'boolean') {
    problems.push(
      `stabilize.waitForPlay must be true or false (got ${show(config.stabilize.waitForPlay)})`,
    );
  }
  const retries = config.stabilize.retries;
  if (!Number.isInteger(retries) || retries < 0) {
    problems.push(`stabilize.retries must be a non-negative integer (got ${show(retries)})`);
  }
  if (
    config.workers !== undefined &&
    !(typeof config.workers === 'number' && Number.isInteger(config.workers) && config.workers > 0) &&
    !(typeof config.workers === 'string' && /^\d+%$/.test(config.workers))
  ) {
    problems.push(
      `workers must be a positive integer or a percentage like "50%" (got ${show(config.workers)})`,
    );
  }
  if (typeof config.fullPage !== 'boolean') {
    problems.push(`fullPage must be true or false (got ${show(config.fullPage)})`);
  }
  if (config.capture !== 'page' && config.capture !== 'component') {
    problems.push(`capture must be "page" or "component" (got ${show(config.capture)})`);
  }
  if (!Array.isArray(config.mask) || !config.mask.every((selector) => typeof selector === 'string')) {
    problems.push(`mask must be an array of selector strings (got ${show(config.mask)})`);
  }
  if (config.affected !== 'all' && config.affected !== 'auto') {
    problems.push(`affected must be "all" or "auto" (got ${show(config.affected)})`);
  }
  if (!['off', 'report', 'fail'].includes(config.accessibility)) {
    problems.push(
      `accessibility must be "off", "report" or "fail" (got ${show(config.accessibility)})`,
    );
  }
  const freezeClock = config.stabilize.freezeClock;
  if (
    freezeClock !== false &&
    (typeof freezeClock !== 'string' || Number.isNaN(Date.parse(freezeClock)))
  ) {
    problems.push(
      `stabilize.freezeClock must be false or a date string Date can parse ` +
        `(got ${show(freezeClock)})`,
    );
  }

  return problems;
}

/** Config file names, in discovery order. */
export const CONFIG_FILENAMES = [
  'diopsis.config.ts',
  'diopsis.config.mts',
  'diopsis.config.mjs',
  'diopsis.config.js',
] as const;

export function findConfigFile(root: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * TypeScript config files are loaded by Node's own type stripping, which is unflagged from
 * Node 22.18. There is no bundler and no transpile dependency, so on older runtimes the
 * `.ts` form genuinely cannot be read and `init` scaffolds `.mjs` instead.
 */
export function supportsTypeStripping(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map((n) => Number.parseInt(n, 10));
  if (major >= 23) return true;
  return major === 22 && minor >= 18;
}

export interface LoadedConfig {
  config: DiopsisConfig;
  /** Absolute path of the file the config came from, or undefined if defaults were used. */
  filepath?: string;
  root: string;
}

export async function loadConfig(root: string = process.cwd()): Promise<LoadedConfig> {
  const filepath = findConfigFile(root);
  if (!filepath) return { config: resolveConfig(), root };

  if (filepath.endsWith('.ts') || filepath.endsWith('.mts')) {
    if (!supportsTypeStripping()) {
      throw new Error(
        `Cannot read ${path.basename(filepath)} on Node ${process.versions.node}: ` +
          'a TypeScript config is loaded by Node\'s built-in type stripping, which needs ' +
          'Node 22.18 or newer. Either upgrade Node, or rename the config to ' +
          'diopsis.config.mjs (the same object, without the type annotations).',
      );
    }
  }

  let module: { default?: UserConfig };
  try {
    module = (await import(pathToFileURL(filepath).href)) as { default?: UserConfig };
  } catch (error) {
    // A config that cannot be imported is a problem in the user's file; Node's raw message
    // names neither the file nor — for a CommonJS .js — the module-format fix.
    const hint = filepath.endsWith('.js')
      ? ' A .js file with ESM syntax needs "type": "module" in package.json, or the .mjs extension.'
      : '';
    throw new Error(
      `Could not load ${path.basename(filepath)}: ` +
        `${error instanceof Error ? error.message : String(error)}${hint}`,
    );
  }
  const user = module.default;
  if (!user || typeof user !== 'object') {
    throw new Error(`${path.basename(filepath)} must export a config object as its default export.`);
  }
  const config = resolveConfig(user);
  const problems = validateConfig(config);
  if (problems.length > 0) {
    // One error listing every problem: a config with three mistakes costs one
    // fix-and-rerun cycle, not three.
    throw new Error(
      problems.length === 1
        ? `${path.basename(filepath)}: ${problems[0]}`
        : `${path.basename(filepath)} has ${problems.length} problems:\n` +
            problems.map((problem) => `  - ${problem}`).join('\n'),
    );
  }
  return { config, filepath, root };
}
