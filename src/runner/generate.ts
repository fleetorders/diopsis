import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ACCEPTED_A11Y_FILENAME } from '../accessibility.ts';
import type { CompareOptions, DiopsisConfig } from '../config.ts';
import { effectiveCompare, type Capture } from '../matrix.ts';

/** Absolute path of this package's compiled `dist` directory. */
export function distRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export interface RunPlan {
  baseUrl: string;
  captures: PlannedCapture[];
  stabilize: DiopsisConfig['stabilize'];
  compare: DiopsisConfig['compare'];
  mask: string[];
  fullPage: boolean;
  /**
   * Whether the accessibility audit runs on the captures marked as its slot, and whether a
   * new finding fails the capture. `'fail'` never survives into an update: a regeneration
   * writes baselines and passes by construction, so nothing in it can be failed.
   */
  accessibility: 'off' | 'report' | 'fail';
  /** Absolute path of the tested project's axe-core entry, present when auditing. */
  axePath?: string;
  /** Absolute path of the accepted-findings file, present when auditing. */
  a11yAcceptedPath?: string;
}

export interface PlannedCapture extends Capture {
  /** Unique, stable Playwright test title. */
  title: string;
  /** `toHaveScreenshot` path segments; joined by Playwright into `{arg}`. */
  segments: string[];
  /** Absolute baseline path, checked before comparing so "new" is not a message guess. */
  baselinePath: string;
  /**
   * The globals this capture's mode resolves to, already looked up from the config so the
   * spec reads plain data and never the config itself. Absent for the base capture.
   */
  globals?: Record<string, string>;
}

export interface GenerateOptions {
  /** Root of the project being tested. */
  root: string;
  config: DiopsisConfig;
  captures: Capture[];
  baseUrl: string;
  /** Absolute path of the reporter module, if one is being attached. */
  reporterPath?: string;
  /** Options handed to the reporter. */
  reporterOptions?: Record<string, unknown>;
  /** `update` regenerates baselines and never retries; `run` (the default) retries per config. */
  mode?: 'run' | 'update';
  /** Absolute path of the tested project's axe-core, when the accessibility audit is on. */
  axePath?: string;
}

export interface GeneratedProject {
  dir: string;
  configPath: string;
  planPath: string;
  cleanup(): Promise<void>;
}

export function planCaptures(
  captures: Capture[],
  snapshotDirAbs: string,
  compare?: CompareOptions,
  modes?: Record<string, Record<string, string>>,
): PlannedCapture[] {
  return captures.map((capture) => ({
    ...capture,
    // Resolved here, once, so the spec runs exactly the comparison the summary reports.
    ...(capture.compare && compare ? { compare: effectiveCompare(compare, capture.compare) } : {}),
    // The mode's globals are resolved the same way — the spec reads the plan, not the config.
    ...(capture.mode !== undefined && modes?.[capture.mode]
      ? { globals: modes[capture.mode] }
      : {}),
    baselinePath: path.join(snapshotDirAbs, capture.snapshotPath),
    title: `${capture.storyId} @${capture.width}` +
      `${capture.mode ? ` [${capture.mode}]` : ''}` +
      `${capture.state ? ` {${capture.state.name}}` : ''}`,
    segments: capture.snapshotPath.split('/'),
  }));
}

/**
 * The generated project lives under the tested project's `node_modules`, not the OS temp
 * directory, so that `@playwright/test` resolves by the ordinary upward lookup. Node's module
 * resolution skips ancestors already named `node_modules`, which puts the project's own
 * `node_modules` on the search path from here.
 */
export function projectDir(root: string): string {
  return path.join(root, 'node_modules', '.diopsis', 'project');
}

export async function generateProject(options: GenerateOptions): Promise<GeneratedProject> {
  const { root, config, baseUrl } = options;
  // Regenerating baselines never retries: the second attempt would compare against the
  // baseline the first attempt just wrote and pass.
  const retries = options.mode === 'update' ? 0 : config.stabilize.retries;
  const dir = projectDir(root);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const snapshotDir = path.resolve(root, config.snapshotDir);
  const outputDir = path.resolve(root, config.outputDir);
  const runtimeUrl = pathToFileURL(path.join(distRoot(), 'runtime', 'capture.js')).href;
  const accessibilityUrl = pathToFileURL(path.join(distRoot(), 'accessibility.js')).href;
  const auditing = config.accessibility !== 'off';
  const plan: RunPlan = {
    baseUrl,
    captures: planCaptures(options.captures, snapshotDir, config.compare, config.modes),
    stabilize: config.stabilize,
    compare: config.compare,
    mask: config.mask,
    fullPage: config.fullPage,
    // An update writes baselines and passes by construction; failing it on findings there
    // would be a `'fail'` run nobody can accept anything from.
    accessibility:
      options.mode === 'update' && config.accessibility === 'fail'
        ? 'report'
        : config.accessibility,
    ...(auditing && options.axePath ? { axePath: options.axePath } : {}),
    ...(auditing
      ? { a11yAcceptedPath: path.join(snapshotDir, ACCEPTED_A11Y_FILENAME) }
      : {}),
  };

  const planPath = path.join(dir, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');

  // `type: module` so the generated `.js` files are ESM regardless of the host project.
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2), 'utf8');

  await writeFile(path.join(dir, 'diopsis.spec.js'), specSource(runtimeUrl, accessibilityUrl), 'utf8');

  // The Diopsis reporter is the only reporter. Playwright's own would print a full failure
  // dump per capture — internals, and absolute paths — for what is, to a user, one line:
  // this story looks different, here is the report.
  const reporters: string[] = [];
  if (options.reporterPath) {
    reporters.push(
      `[${JSON.stringify(options.reporterPath)}, ${JSON.stringify(options.reporterOptions ?? {})}]`,
    );
  } else {
    reporters.push(`['dot']`);
  }

  const configSource = `// Generated by Diopsis. Rewritten on every run; edits are lost.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: ${JSON.stringify(dir)},
  outputDir: ${JSON.stringify(path.join(outputDir, 'test-results'))},
  fullyParallel: true,
  forbidOnly: false,
  retries: ${retries},
  ${config.workers === undefined ? '' : `workers: ${JSON.stringify(config.workers)},\n  `}timeout: ${config.timeout},
  reporter: [${reporters.join(', ')}],
  snapshotPathTemplate: ${JSON.stringify(path.join(snapshotDir, '{arg}{ext}'))},
  use: {
    baseURL: ${JSON.stringify(baseUrl)},
    deviceScaleFactor: 1,
    colorScheme: 'light',
    // Locale and timezone are pinned for the same reason the clock is frozen: they change
    // rendered text, and a machine-dependent default makes a baseline machine-dependent.
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 } }],
});
`;

  const configPath = path.join(dir, 'playwright.config.js');
  await writeFile(configPath, configSource, 'utf8');

  return {
    dir,
    configPath,
    planPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function specSource(runtimeUrl: string, accessibilityUrl: string): string {
  return `// Generated by Diopsis. Rewritten on every run; edits are lost.
import { existsSync, readFileSync } from 'node:fs';
import { devices, expect, test } from '@playwright/test';
import { applyState, auditAccessibility, componentClip, openStory, releaseState, storyUrlFor } from ${JSON.stringify(runtimeUrl)};
import { a11yFailureOf } from ${JSON.stringify(accessibilityUrl)};

const plan = JSON.parse(readFileSync(new URL('./plan.json', import.meta.url), 'utf8'));

// The accessibility audit's two inputs, read once per run: the library the tested project
// installed, and the findings it has already accepted. Both live outside the generated
// project on purpose — the plan names where, the spec never decides.
const axeSource = plan.axePath ? readFileSync(plan.axePath, 'utf8') : null;
function readAccepted(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    // Reading an unreadable file as empty would turn every accepted finding new again in
    // a 'fail' run, so the file is refused — named, with the remedy.
    throw new Error(file + ' is not valid JSON. Fix it or remove it, then re-run.');
  }
}
const acceptedA11y = plan.a11yAcceptedPath ? readAccepted(plan.a11yAcceptedPath) : {};

test.describe.configure({ mode: 'parallel' });

// One page per worker, reused for every capture that worker takes: a fresh browser context per
// capture cost a third of the run. openStory clears the previous story's storage before each
// navigation, so no capture can see another's state. The options mirror the project's \`use\`
// block, which worker-scoped fixtures do not receive.
const contextOptions = {
  ...devices['Desktop Chrome'],
  deviceScaleFactor: 1,
  colorScheme: 'light',
  locale: 'en-US',
  timezoneId: 'UTC',
};

const it = test.extend({
  storyPage: [async ({ browser }, use) => {
    const context = await browser.newContext(contextOptions);
    await use(await context.newPage());
    await context.close();
  }, { scope: 'worker' }],
  // A story that crashed the page must not take the rest of the worker's captures with it.
  page: async ({ storyPage, browser }, use) => {
    if (!storyPage.isClosed()) return use(storyPage);
    const context = await browser.newContext(contextOptions);
    await use(await context.newPage());
    await context.close();
  },
});

for (const capture of plan.captures) {
  it(capture.title, async ({ page }) => {
    // Baseline existence decides "new" against "changed"; Playwright words a missing
    // snapshot differently per mode and version, while the filesystem does not.
    test.info().annotations.push({
      type: 'diopsis-baseline',
      description: existsSync(capture.baselinePath) ? 'present' : 'missing',
    });

    await page.setViewportSize({ width: capture.width, height: capture.height });
    await openStory(page, storyUrlFor(plan.baseUrl, capture.storyId, capture.globals), plan.stabilize);

    // A story's tolerance tags were resolved against the configured comparison when the plan
    // was written; a capture without them runs the configured comparison as it is.
    const compare = capture.compare ?? plan.compare;

    // The interaction state is held for the shutter — a pressed element stays pressed
    // through the comparison — and released however the capture ends: this page is reused
    // for the worker's next capture, which must not inherit a held mouse button. Focus and
    // hover need no cleanup of their own; the next capture's navigation replaces the
    // document they lived in.
    try {
      if (capture.state) await applyState(page, capture.state);

      // A component-scoped capture photographs the rendered component alone. The clip rides a
      // full-page screenshot so a component below the fold is reachable; a story with nothing
      // to clip falls back to the page and says so, rather than capturing nothing. It is
      // measured after the state, so a state that changes what is drawn changes the clip.
      let clip;
      if (capture.scope === 'component') {
        clip = await componentClip(page);
        if (!clip) {
          test.info().annotations.push({ type: 'diopsis-scope', description: 'fell back to page' });
        }
      }

      await expect(page).toHaveScreenshot(capture.segments, {
        fullPage: clip ? true : plan.fullPage,
        ...(clip ? { clip } : {}),
        animations: plan.stabilize.disableAnimations ? 'disabled' : 'allow',
        caret: 'hide',
        scale: 'css',
        mask: plan.mask.map((selector) => page.locator(selector)),
        maskColor: '#ff00ff',
        threshold: compare.threshold,
        // Each limit is passed only when set; Playwright applies the stricter when both are.
        ...(compare.maxDiffPixelRatio === undefined ? {} : { maxDiffPixelRatio: compare.maxDiffPixelRatio }),
        ...(compare.maxDiffPixels === undefined ? {} : { maxDiffPixels: compare.maxDiffPixels }),
      });
    } finally {
      if (capture.state) await releaseState(page);
    }

    // The accessibility audit: once per story and mode, on the capture the plan marked —
    // its first width, never an interaction state — and strictly after the screenshot, so
    // nothing it does can touch the pixels the comparison just judged. The findings ride
    // the result as an annotation; in 'fail' mode a new finding fails the capture like a
    // change, which is why this throw sits outside the try above: the state is already
    // released and the page's own verdict is already recorded.
    if (capture.a11y && plan.accessibility !== 'off' && axeSource) {
      const violations = await auditAccessibility(page, axeSource);
      test.info().annotations.push({ type: 'diopsis-a11y', description: JSON.stringify(violations) });
      if (plan.accessibility === 'fail') {
        const failure = a11yFailureOf(violations, acceptedA11y, capture.storyId, capture.mode);
        if (failure) throw new Error(failure);
      }
    }
  });
}
`;
}
