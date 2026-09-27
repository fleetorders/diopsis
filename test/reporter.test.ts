import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { FullConfig, FullResult, TestCase, TestResult } from '@playwright/test/reporter';
import { deflateSync } from 'node:zlib';

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

/*
 * A just-enough PNG encoder for the region tests: filter-0 scanlines of opaque pixels.
 * The png suite's encoder is deliberately richer; this one stays minimal and private so
 * the two cannot share a mistake.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function pngOf(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(height * stride); // one filter byte (0) per scanline
  for (let y = 0; y < height; y++) {
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A diff-shaped image: the greyed-out baseline with pure-red blocks painted on it. */
function diffPng(
  width: number,
  height: number,
  blocks: ReadonlyArray<readonly [number, number, number, number]> = [],
): Buffer {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 128;
    rgba[i + 1] = 128;
    rgba[i + 2] = 128;
    rgba[i + 3] = 255;
  }
  for (const [x, y, w, h] of blocks) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const i = ((y + dy) * width + (x + dx)) * 4;
        rgba[i] = 255;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
      }
    }
  }
  return pngOf(width, height, rgba);
}

/** One changed capture whose artifacts are real files, run through to the written summary. */
async function runChanged(
  reporter: DiopsisReporter,
  outputDir: string,
  actual: Buffer,
  diff: Buffer,
): Promise<RunSummary> {
  const actualPath = path.join(outputDir, 'a--one-320-actual.png');
  const diffPath = path.join(outputDir, 'a--one-320-diff.png');
  await writeFile(actualPath, actual);
  await writeFile(diffPath, diff);
  await withCapturedStdout(async () => {
    reporter.onTestEnd(
      testTitled('a--one @320'),
      result({
        status: 'failed',
        errors: [{ message: '12 pixels (ratio 0.06 of all image pixels) are different.' }],
        annotations: [{ type: 'diopsis-baseline', description: 'present' }],
        attachments: [
          { name: 'actual-image', contentType: 'image/png', path: actualPath },
          { name: 'diff-image', contentType: 'image/png', path: diffPath },
        ],
      }),
    );
    await reporter.onEnd({ status: 'failed' } as FullResult);
  });
  return summaryAt(outputDir);
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

describe('DiopsisReporter changed regions', () => {
  it('locates the regions of a changed capture and the size of its actual image', async () => {
    const { reporter, outputDir } = await setup();
    const summary = await runChanged(
      reporter,
      outputDir,
      diffPng(20, 10),
      diffPng(20, 10, [[4, 3, 6, 2]]),
    );

    const changed = summary.captures.find((c) => c.storyId === 'a--one' && c.width === 320);
    assert.equal(changed?.status, 'changed');
    assert.deepEqual(changed?.regions, [{ x: 4, y: 3, width: 6, height: 2, pixels: 12 }]);
    assert.deepEqual(changed?.size, { width: 20, height: 10 });
    assert.equal(changed?.regionsDropped, undefined);
  });

  it('records no regions when the diff cannot be decoded, and the run still completes', async () => {
    const { reporter, outputDir } = await setup();
    const summary = await runChanged(
      reporter,
      outputDir,
      diffPng(20, 10),
      Buffer.from('this file is not a PNG, whatever its name says', 'utf8'),
    );

    const changed = summary.captures.find((c) => c.storyId === 'a--one' && c.width === 320);
    assert.equal(changed?.status, 'changed');
    assert.equal(changed?.regions, undefined);
    assert.equal(changed?.size, undefined);
    assert.equal(changed?.regionsDropped, undefined);
  });

  it('caps the recorded regions at 20 and counts the rest as dropped', async () => {
    // Twenty-five single-pixel dots on a 5x5 grid, 20px apart — beyond the merge gap, so
    // each is its own region and the cap is what drops the last five.
    const dots: Array<readonly [number, number, number, number]> = [];
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 5; gx++) dots.push([5 + gx * 20, 5 + gy * 20, 1, 1]);
    }
    const { reporter, outputDir } = await setup();
    const summary = await runChanged(reporter, outputDir, diffPng(100, 100), diffPng(100, 100, dots));

    const changed = summary.captures.find((c) => c.storyId === 'a--one' && c.width === 320);
    assert.equal(changed?.regions?.length, 20);
    assert.equal(changed?.regionsDropped, 5);
    // Ties on pixel count order top-down then left-to-right, so the first rows survive.
    assert.deepEqual(changed?.regions?.[0], { x: 5, y: 5, width: 1, height: 1, pixels: 1 });
    assert.deepEqual(changed?.regions?.[19], { x: 85, y: 65, width: 1, height: 1, pixels: 1 });
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

describe('DiopsisReporter modes', () => {
  it('carries the mode into the summary and the terminal line', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'diopsis-reporter-'));
    temporaries.push(root);
    const modes = { dark: { theme: 'dark' } };
    const config = resolveConfig({ viewports: { default: [320] }, modes });
    const { captures } = resolveMatrix([stories[0]!], config, 'linux-x64');
    const planned = planCaptures(captures, path.join(root, '__screenshots__'), undefined, modes);
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
    const { out } = await withCapturedStdout(async () => {
      reporter.onTestEnd(testTitled('a--one @320'), result({}));
      reporter.onTestEnd(
        testTitled('a--one @320 [dark]'),
        result({
          status: 'failed',
          errors: [{ message: '500 pixels (ratio 0.1 of all image pixels) are different.' }],
          annotations: [{ type: 'diopsis-baseline', description: 'present' }],
        }),
      );
      await reporter.onEnd({ status: 'failed' } as FullResult);
    });

    const summary = await summaryAt(outputDir);
    assert.equal(summary.captures.find((c) => c.mode === 'dark')?.status, 'changed');
    // The base capture carries no mode key at all, so it stays byte-identical to before.
    assert.equal('mode' in (summary.captures[0] ?? {}), false);
    assert.match(out, /~ a--one @320 \[dark\]  500 px differ/);
  });
});
