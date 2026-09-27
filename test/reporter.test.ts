import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { FullConfig, FullResult, TestCase, TestResult } from '@playwright/test/reporter';

import { resolveConfig } from '../src/config.ts';
import { resolveMatrix } from '../src/matrix.ts';
import DiopsisReporter from '../src/reporter.ts';
import { NOT_RUN, type RunSummary } from '../src/report/summary.ts';
import { planCaptures } from '../src/runner/generate.ts';
import type { StoryEntry } from '../src/story-index.ts';

const stories: StoryEntry[] = [
  { id: 'a--one', name: 'One', title: 'A', tags: [] },
  { id: 'b--two', name: 'Two', title: 'B', tags: [] },
];

const temporaries: string[] = [];

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(
  withStories: StoryEntry[] = stories,
): Promise<{ reporter: DiopsisReporter; outputDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'diopsis-reporter-'));
  temporaries.push(root);
  const config = resolveConfig();
  const { captures } = resolveMatrix(withStories, config, 'linux-x64');
  const planned = planCaptures(captures, path.join(root, '__screenshots__'));
  const outputDir = path.join(root, '.diopsis');
  await mkdir(outputDir, { recursive: true });
  const planPath = path.join(root, 'plan.json');
  await writeFile(
    planPath,
    JSON.stringify({
      baseUrl: 'http://127.0.0.1:4321',
      captures: planned,
      stabilize: config.stabilize,
      compare: config.compare,
      mask: config.mask,
      fullPage: config.fullPage,
    }),
  );
  const reporter = new DiopsisReporter({
    planPath,
    outputDir,
    snapshotDir: '__screenshots__',
    snapshotDirAbs: path.join(root, '__screenshots__'),
    mode: 'run',
    platform: 'linux',
    arch: 'x64',
    createdAt: '2026-01-01T00:00:00Z',
  });
  await reporter.onBegin({} as FullConfig);
  return { reporter, outputDir };
}

const testTitled = (title: string): TestCase => ({ title }) as TestCase;

const result = (over: Partial<TestResult>): TestResult =>
  ({ status: 'passed', errors: [], attachments: [], annotations: [], ...over }) as TestResult;

async function summaryAt(outputDir: string): Promise<RunSummary> {
  return JSON.parse(await readFile(path.join(outputDir, 'summary.json'), 'utf8')) as RunSummary;
}

/** The reporter prints its console block on stdout; these tests read the summary file. */
async function withCapturedStdout<T>(run: () => Promise<T>): Promise<{ value: T; out: string }> {
  const write = process.stdout.write;
  let out = '';
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof write;
  try {
    const value = await run();
    return { value, out };
  } finally {
    process.stdout.write = write;
  }
}

describe('DiopsisReporter', () => {
  it('classifies a missing baseline from the annotation, not the message wording', async () => {
    const { reporter, outputDir } = await setup();
    await withCapturedStdout(async () => {
      reporter.onTestEnd(
        testTitled('a--one @320'),
        result({
          status: 'failed',
          // The --update-snapshots=none wording, which the message regexes cannot catch.
          errors: [
            { message: "A snapshot doesn't exist at /repo/__screenshots__/a--one/320w-linux-x64.png." },
          ],
          annotations: [{ type: 'diopsis-baseline', description: 'missing' }],
        }),
      );
      await reporter.onEnd({ status: 'failed' } as FullResult);
    });

    const summary = await summaryAt(outputDir);
    const failed = summary.captures.find((c) => c.storyId === 'a--one' && c.width === 320);
    assert.equal(failed?.status, 'new');
  });

  it('records an interrupted run: nothing ran, everything is listed as not run', async () => {
    const { reporter, outputDir } = await setup();
    const { out } = await withCapturedStdout(async () => {
      reporter.onTestEnd(testTitled('a--one @320'), result({ status: 'interrupted' }));
      reporter.onTestEnd(testTitled('b--two @320'), result({ status: 'skipped' }));
      await reporter.onEnd({ status: 'interrupted' } as FullResult);
    });

    const summary = await summaryAt(outputDir);
    assert.equal(summary.interrupted, true);
    // Four captures were planned; none completed, so all four are not-run, not failed.
    assert.equal(summary.totals.notRun, 4);
    assert.equal(summary.totals.failed, 0);
    assert.equal(summary.captures.length, 4);
    assert.equal(summary.captures[0]?.status, 'failed');
    assert.equal(summary.captures[0]?.error, NOT_RUN);
    assert.match(out, /run interrupted — 4 captures did not run/);
    assert.deepEqual(summary.changedStories, []);
  });

  it('fills in only the captures the run never reached', async () => {
    const { reporter, outputDir } = await setup();
    await withCapturedStdout(async () => {
      reporter.onTestEnd(testTitled('a--one @320'), result({}));
      await reporter.onEnd({ status: 'interrupted' } as FullResult);
    });

    const summary = await summaryAt(outputDir);
    assert.equal(summary.interrupted, true);
    assert.equal(summary.totals.unchanged, 1);
    assert.equal(summary.totals.notRun, 3);
  });

  it('leaves an uninterrupted summary without the interrupted marker', async () => {
    const { reporter, outputDir } = await setup();
    await withCapturedStdout(async () => {
      reporter.onTestEnd(testTitled('a--one @320'), result({}));
      await reporter.onEnd({ status: 'failed' } as FullResult);
    });

    const summary = await summaryAt(outputDir);
    assert.equal(summary.interrupted, undefined);
    assert.equal(summary.totals.notRun, 0);
  });

  it('formats differing pixel counts with a pinned locale, not the machine’s', async () => {
    const { reporter } = await setup();
    const original = Number.prototype.toLocaleString;
    // A machine whose locale groups with dots prints "1.234.567 px differ" from the same
    // run unless the locale is pinned; the terminal output must read the same everywhere.
    Number.prototype.toLocaleString = function (this: Number, locale?: string | string[]) {
      return original.call(this, locale ?? 'de-DE');
    };
    let out: string;
    try {
      ({ out } = await withCapturedStdout(async () => {
        reporter.onTestEnd(
          testTitled('a--one @320'),
          result({
            status: 'failed',
            errors: [
              { message: '1,234,567 pixels (ratio 0.5 of all image pixels) are different.' },
            ],
            annotations: [{ type: 'diopsis-baseline', description: 'present' }],
          }),
        );
        await reporter.onEnd({ status: 'failed' } as FullResult);
      }));
    } finally {
      Number.prototype.toLocaleString = original;
    }
    assert.match(out, /~ a--one @320  1,234,567 px differ/);
  });
});

describe('DiopsisReporter per-story tolerance', () => {
  it('records the tolerance in effect, and only for the stories that set one', async () => {
    const { reporter, outputDir } = await setup([
      { id: 'a--one', name: 'One', title: 'A', tags: ['diopsis:threshold=0.4'] },
      { id: 'b--two', name: 'Two', title: 'B', tags: [] },
    ]);
    await withCapturedStdout(async () => {
      reporter.onTestEnd(testTitled('a--one @320'), result({}));
      reporter.onTestEnd(testTitled('b--two @320'), result({}));
      await reporter.onEnd({ status: 'passed' } as FullResult);
    });

    const summary = await summaryAt(outputDir);
    assert.deepEqual(
      summary.captures.find((c) => c.storyId === 'a--one' && c.width === 320)?.tolerance,
      { threshold: 0.4 },
    );
    assert.equal(
      summary.captures.find((c) => c.storyId === 'b--two' && c.width === 320)?.tolerance,
      undefined,
    );
  });
});

describe('error text', () => {
  it('keeps the message once and drops stack frames', async () => {
    const { errorTextOf } = await import('../src/reporter.ts');
    const text = errorTextOf({
      status: 'failed',
      errors: [
        {
          message: 'StoryRenderError: Story play function failed: play broke',
          stack:
            'StoryRenderError: Story play function failed: play broke\n    at stabilize (/x/capture.js:1:1)',
        },
      ],
    });
    assert.equal(text, 'StoryRenderError: Story play function failed: play broke');
  });
});
