import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

import { decodePng, pngSize } from './png.ts';
import { findRegions } from './regions.ts';
import { renderReport } from './report/html.ts';
import {
  changedStoriesOf,
  classify,
  indexPlanByTitle,
  NOT_RUN,
  totalsFor,
  type CaptureArtifacts,
  type CaptureResult,
  type CaptureStatus,
  type CarriedCapture,
  type RunSummary,
} from './report/summary.ts';
import type { PlannedCapture, RunPlan } from './runner/generate.ts';

export interface DiopsisReporterOptions {
  /** Absolute path of the run plan written by the generator. */
  planPath: string;
  /** Absolute path of the directory the report and summary are written to. */
  outputDir: string;
  /** Configured snapshot directory, as written — for display. */
  snapshotDir: string;
  /** Absolute snapshot directory, for locating baselines. */
  snapshotDirAbs: string;
  mode: 'run' | 'update';
  /** The shard this run captures, when it was started with `--shard`; kept in the summary. */
  shard?: { index: number; total: number };
  /**
   * Retries the run was generated with. Region computation starts only on the attempt that
   * can decide a capture — the one no retry can replace — so a superseded attempt's diff is
   * never decoded.
   */
  retries: number;
  platform: string;
  arch: string;
  /** Fixed timestamp, so a report is reproducible when the run is. */
  createdAt: string;
  /** Change-aware runs: what the affected set was decided against. */
  affected?: RunSummary['affected'];
  /** Change-aware runs: the planned captures not shot, carried from their baselines. */
  carried?: CarriedCapture[];
}

/**
 * Sort the comparator's three images.
 *
 * Classification is by file path, not attachment name: the `-expected`/`-actual`/`-diff`
 * suffix is part of the filename Playwright writes, and the attachment names do not
 * distinguish them — reading the name collapses all three onto one entry.
 */
export function artifactsOf(
  attachments: readonly { name: string; path?: string; contentType: string }[],
  outputDir: string,
): CaptureArtifacts {
  const artifacts: CaptureArtifacts = {};
  for (const attachment of attachments) {
    if (!attachment.path || attachment.contentType !== 'image/png') continue;
    const relative = path.relative(outputDir, attachment.path);
    const base = path.basename(attachment.path);
    if (base.endsWith('-expected.png')) artifacts.expected = relative;
    else if (base.endsWith('-diff.png')) artifacts.diff = relative;
    else artifacts.actual = relative;
  }
  return artifacts;
}

/** Playwright colours its error messages; a JSON file and an HTML report want neither. */
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Regions kept per capture: enough to navigate and to crop a tile to, few enough that a
 * heavily changed capture still reads as a handful of places rather than a texture.
 */
const MAX_REGIONS = 20;

export function stripAnsi(value: string): string {
  return value.replace(ANSI, '');
}

export function errorTextOf(result: Pick<TestResult, 'status' | 'errors'>): string {
  // A stack begins with the message it belongs to; printing both repeated every error.
  const parts = result.errors.map((error) =>
    error.stack && error.message && error.stack.includes(error.message)
      ? error.stack
      : `${error.message ?? ''}\n${error.stack ?? ''}`,
  );
  if (result.status === 'timedOut') parts.push('Test timed out.');
  // Stack frames name this machine's paths and Diopsis's internals; neither helps a reader
  // decide what happened to their story, and both would be pasted into reviews.
  return stripAnsi(parts.join('\n'))
    .split('\n')
    .filter((line) => !/^\s+at /.test(line))
    .join('\n');
}

/** The spec records baseline existence as an annotation; Playwright's wording is not ours. */
function baselineOf(result: TestResult): 'present' | 'missing' | undefined {
  const description = result.annotations.find((a) => a.type === 'diopsis-baseline')?.description;
  return description === 'present' || description === 'missing' ? description : undefined;
}

/** A capture the run never reached still has to appear in the summary, as not-run. */
function notRunCapture(planned: PlannedCapture): CaptureResult {
  return {
    storyId: planned.storyId,
    storyTitle: planned.storyTitle,
    storyName: planned.storyName,
    width: planned.width,
    status: 'failed',
    ...(planned.mode ? { mode: planned.mode } : {}),
    ...(planned.state ? { state: planned.state.name } : {}),
    snapshotPath: planned.snapshotPath,
    ...(planned.compare ? { tolerance: planned.compare } : {}),
    error: NOT_RUN,
    artifacts: {},
  };
}

/**
 * Playwright reporter that owns the review surface.
 *
 * A reporter is the smallest stable extension point that sees every result, which is what
 * lets Diopsis delegate the runner and still own the part that is differentiated
 * (DECISIONS.md §2).
 */
export default class DiopsisReporter implements Reporter {
  private readonly options: DiopsisReporterOptions;
  private readonly results = new Map<string, CaptureResult>();
  /**
   * First attempt per capture, keyed by title. A retry re-takes the capture from a fresh
   * page — flake that survives stabilization lives between page loads — so what the first
   * attempt saw is what the flake guard reports.
   */
  private readonly firstAttempts = new Map<
    string,
    { status: CaptureStatus; diffPixels?: number }
  >();
  /**
   * Captures whose first attempt found no baseline. The retry would compare against the
   * baseline that attempt wrote and pass, so the first classification is latched.
   */
  private readonly latchedNew = new Set<string>();
  /** Region passes in flight; onEnd awaits every one before writing the summary. */
  private readonly regionWork: Promise<void>[] = [];
  private plan: RunPlan | undefined;
  private planByTitle: Map<string, PlannedCapture> | undefined;

  constructor(options: DiopsisReporterOptions) {
    this.options = options;
  }

  printsToStdio(): boolean {
    return true;
  }

  /**
   * The baseline is located from the snapshot path rather than read off an attachment.
   * Playwright's "expected" attachment points at the baseline file itself, whose name carries
   * no `-expected` suffix to sort it by — and the baseline is exactly what the report's
   * before-image should be anyway.
   */
  private artifactsFor(snapshotPath: string, result: TestResult): CaptureArtifacts {
    const artifacts = artifactsOf(result.attachments, this.options.outputDir);
    if (!artifacts.expected) {
      const baseline = path.join(this.options.snapshotDirAbs, snapshotPath);
      if (existsSync(baseline)) {
        artifacts.expected = path.relative(this.options.outputDir, baseline);
      }
    }
    return artifacts;
  }

  async onBegin(_config: FullConfig): Promise<void> {
    this.plan = JSON.parse(await readFile(this.options.planPath, 'utf8')) as RunPlan;
    // Built once here: re-indexing per test was the reporter's own quadratic on large suites.
    this.planByTitle = indexPlanByTitle(this.plan.captures);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const planned = this.planByTitle?.get(test.title);
    if (!planned) return;

    // An interrupted or skipped test compared nothing at all; recording it as a plain
    // failure with no text is how an aborted run looks like a small, clean one.
    if (result.status === 'interrupted' || result.status === 'skipped') {
      this.results.set(planned.title, notRunCapture(planned));
      return;
    }

    const errorText = errorTextOf(result).trim();
    const verdict = classify({
      passed: result.status === 'passed',
      errorText,
      timedOut: result.status === 'timedOut',
      baseline: baselineOf(result),
    });

    const artifacts = this.artifactsFor(planned.snapshotPath, result);
    const capture: CaptureResult = {
      storyId: planned.storyId,
      storyTitle: planned.storyTitle,
      storyName: planned.storyName,
      width: planned.width,
      status: verdict.status,
      ...(planned.mode ? { mode: planned.mode } : {}),
      ...(planned.state ? { state: planned.state.name } : {}),
      snapshotPath: planned.snapshotPath,
      ...(planned.compare ? { tolerance: planned.compare } : {}),
      ...(verdict.diffPixels === undefined ? {} : { diffPixels: verdict.diffPixels }),
      ...(verdict.diffRatio === undefined ? {} : { diffRatio: verdict.diffRatio }),
      ...(verdict.status === 'unchanged' || !errorText
        ? {}
        : { error: errorText.split('\n').slice(0, 4).join('\n') }),
      artifacts,
    };

    const first = this.firstAttempts.get(planned.title);
    if (!first) {
      this.firstAttempts.set(planned.title, {
        status: verdict.status,
        ...(verdict.diffPixels === undefined ? {} : { diffPixels: verdict.diffPixels }),
      });
      if (verdict.status === 'new') this.latchedNew.add(planned.title);
    } else if (this.latchedNew.has(planned.title)) {
      // The retry of a new capture compared against the baseline the first attempt wrote;
      // whatever it says, the capture is new.
      return;
    } else if (verdict.status === 'unchanged') {
      // Differed on one load of the story, matched on the next: not a change, and not a
      // quietly green pass either — the run reports what the load that differed showed.
      capture.unstable = true;
      capture.unstableStatus = first.status;
      if (first.diffPixels !== undefined) capture.unstableDiffPixels = first.diffPixels;
    }
    // A capture that fails every attempt keeps its final attempt's classification: the last
    // load of the story is the one the run just looked at.
    this.results.set(planned.title, capture);

    // Where the capture changed is asked for after the run, so the work starts now, off
    // this callback's critical path, and fills the result in as captures continue — but
    // only on the attempt that decides the capture: while a retry can still replace this
    // result, its diff is not the one the report will show.
    if (verdict.status === 'changed' && artifacts.diff && (result.retry ?? 0) >= this.options.retries) {
      const actual = artifacts.actual
        ? path.resolve(this.options.outputDir, artifacts.actual)
        : undefined;
      this.regionWork.push(
        this.locateRegions(capture, path.resolve(this.options.outputDir, artifacts.diff), actual),
      );
    }
  }

  /**
   * Decode a changed capture's diff and record where it changed, plus the pixel size of
   * the actual render. The pass closes over the result object rather than looking it up
   * by title, so a retried capture's earlier pass can only ever touch an orphaned result.
   * Anything unreadable — a missing file, a format the decoder rejects — leaves the
   * capture without regions: the run's verdicts never depended on this pass.
   */
  private async locateRegions(capture: CaptureResult, diffPath: string, actualPath?: string): Promise<void> {
    try {
      const [diff, actual] = await Promise.all([
        readFile(diffPath),
        actualPath ? readFile(actualPath) : undefined,
      ]);
      // The diff is what the boxes are drawn over, so its decoded dimensions are the
      // coordinates regions live in; the actual render is the same size whenever a
      // diff exists, and is what `size` documents.
      const image = decodePng(diff);
      const { regions, dropped } = findRegions(image.rgba, image.width, image.height, {
        max: MAX_REGIONS,
      });
      capture.size = actual ? pngSize(actual) : { width: image.width, height: image.height };
      if (regions.length > 0) capture.regions = regions;
      if (dropped > 0) capture.regionsDropped = dropped;
    } catch {
      // A diff that cannot be decoded is not a verdict about the capture.
    }
  }

  async onEnd(runResult: FullResult): Promise<void> {
    // Every region pass must land before the summary freezes the results it mutates.
    await Promise.all(this.regionWork);
    const interrupted = runResult.status === 'interrupted';
    // Report in plan order, so the list is stable between runs rather than finish-order.
    // A capture the run never reached is still listed: an interrupted run must not
    // present itself as a smaller run that simply passed.
    const ordered = (this.plan?.captures ?? [])
      .map((capture) =>
        this.results.get(capture.title) ?? (interrupted ? notRunCapture(capture) : undefined),
      )
      .filter((capture): capture is CaptureResult => capture !== undefined);

    const summary: RunSummary = {
      diopsis: 1,
      createdAt: this.options.createdAt,
      platform: this.options.platform,
      arch: this.options.arch,
      mode: this.options.mode,
      ...(this.options.shard ? { shard: this.options.shard } : {}),
      ...(interrupted ? { interrupted: true } : {}),
      snapshotDir: this.options.snapshotDir,
      totals: {
        ...totalsFor(ordered),
        ...(this.options.carried ? { carried: this.options.carried.length } : {}),
      },
      changedStories: changedStoriesOf(ordered),
      captures: ordered,
      ...(this.options.affected ? { affected: this.options.affected } : {}),
      ...(this.options.carried ? { carried: this.options.carried } : {}),
    };

    await mkdir(this.options.outputDir, { recursive: true });
    const summaryPath = path.join(this.options.outputDir, 'summary.json');
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    const reportPath = path.join(this.options.outputDir, 'report.html');
    await writeFile(reportPath, await renderReport(summary, this.options.outputDir), 'utf8');

    const { totals } = summary;
    // Relative to where the command was run: an absolute path is noise to a reader and
    // machine-specific to anyone the output is pasted to.
    const show = (target: string): string =>
      (path.relative(process.cwd(), target) || target).split(path.sep).join('/');

    const counts = [
      `${totals.unchanged} unchanged`,
      ...(totals.changed ? [`${totals.changed} changed`] : []),
      ...(totals.new ? [`${totals.new} new`] : []),
      ...(totals.renderFailed ? [`${totals.renderFailed} failed to render`] : []),
      ...(totals.failed ? [`${totals.failed} failed`] : []),
    ];

    // The run header already ends in a blank line; opening with another printed two.
    const lines = [
      ...(totals.notRun > 0
        ? [`  run interrupted — ${totals.notRun} captures did not run`]
        : []),
      `  ${counts.join(' · ')}`,
      ...(totals.unstable > 0
        ? [`  ${totals.unstable} unstable — differed on one load, matched on the next`]
        : []),
      '',
    ];

    for (const capture of ordered) {
      if (capture.status === 'unchanged' && !capture.unstable) continue;
      // A pinned locale, not the machine's: the same run must print the same figures on
      // every machine it is pasted from.
      const detail = capture.unstable
        ? capture.unstableDiffPixels === undefined
          ? (capture.unstableStatus ?? 'unstable')
          : `${capture.unstableDiffPixels.toLocaleString('en-US')} px differ`
        : capture.diffPixels === undefined
          ? capture.status
          : `${capture.diffPixels.toLocaleString('en-US')} px differ`;
      const mark = capture.unstable ? '?' : capture.status === 'changed' ? '~' : '+';
      lines.push(
        `  ${mark} ${capture.storyId} @${capture.width}` +
          `${capture.mode ? ` [${capture.mode}]` : ''}` +
          `${capture.state ? ` {${capture.state}}` : ''}  ${detail}`,
      );
      if (capture.status === 'render-failed' || capture.status === 'failed') {
        for (const line of (capture.error ?? '').split('\n').slice(0, 2)) {
          if (line.trim()) lines.push(`      ${line.trim()}`);
        }
      }
    }

    if (counts.length > 1 || totals.unstable > 0) lines.push('');
    lines.push(`  report   ${show(reportPath)}`, `  summary  ${show(summaryPath)}`);

    if (summary.changedStories.length > 0 && summary.mode === 'run') {
      // A shard's captures are a slice of the review; the whole review — and the accept —
      // begins once the shards are merged, so that is what a shard run points at.
      lines.push(
        '',
        this.options.shard
          ? '  Merge the shards for one review:  npx diopsis merge'
          : '  Accept as the new baseline:  npx diopsis accept',
      );
    }
    lines.push('');
    process.stdout.write(lines.join('\n'));
  }
}
