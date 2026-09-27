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

import { renderReport } from './report/html.ts';
import {
  changedStoriesOf,
  classify,
  indexPlanByTitle,
  NOT_RUN,
  totalsFor,
  type CaptureArtifacts,
  type CaptureResult,
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
  platform: string;
  arch: string;
  /** Fixed timestamp, so a report is reproducible when the run is. */
  createdAt: string;
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

export function stripAnsi(value: string): string {
  return value.replace(ANSI, '');
}

function errorTextOf(result: TestResult): string {
  const parts = result.errors.map((error) => `${error.message ?? ''}\n${error.stack ?? ''}`);
  if (result.status === 'timedOut') parts.push('Test timed out.');
  return stripAnsi(parts.join('\n'));
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
    snapshotPath: planned.snapshotPath,
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

    this.results.set(planned.title, {
      storyId: planned.storyId,
      storyTitle: planned.storyTitle,
      storyName: planned.storyName,
      width: planned.width,
      status: verdict.status,
      snapshotPath: planned.snapshotPath,
      ...(verdict.diffPixels === undefined ? {} : { diffPixels: verdict.diffPixels }),
      ...(verdict.diffRatio === undefined ? {} : { diffRatio: verdict.diffRatio }),
      ...(verdict.status === 'unchanged' || !errorText
        ? {}
        : { error: errorText.split('\n').slice(0, 4).join('\n') }),
      artifacts: this.artifactsFor(planned.snapshotPath, result),
    });
  }

  async onEnd(runResult: FullResult): Promise<void> {
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
      ...(interrupted ? { interrupted: true } : {}),
      snapshotDir: this.options.snapshotDir,
      totals: totalsFor(ordered),
      changedStories: changedStoriesOf(ordered),
      captures: ordered,
    };

    await mkdir(this.options.outputDir, { recursive: true });
    const summaryPath = path.join(this.options.outputDir, 'summary.json');
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    const reportPath = path.join(this.options.outputDir, 'report.html');
    await writeFile(reportPath, await renderReport(summary, this.options.outputDir), 'utf8');

    const { totals } = summary;
    // Relative to where the command was run: an absolute path is noise to a reader and
    // machine-specific to anyone the output is pasted to.
    const show = (target: string): string => path.relative(process.cwd(), target) || target;

    const counts = [
      `${totals.unchanged} unchanged`,
      ...(totals.changed ? [`${totals.changed} changed`] : []),
      ...(totals.new ? [`${totals.new} new`] : []),
      ...(totals.renderFailed ? [`${totals.renderFailed} failed to render`] : []),
      ...(totals.failed ? [`${totals.failed} failed`] : []),
    ];

    const lines = [
      '',
      ...(totals.notRun > 0
        ? [`  run interrupted — ${totals.notRun} captures did not run`]
        : []),
      `  ${counts.join(' · ')}`,
      '',
    ];

    for (const capture of ordered) {
      if (capture.status === 'unchanged') continue;
      const detail =
        capture.diffPixels === undefined
          ? capture.status
          : `${capture.diffPixels.toLocaleString()} px differ`;
      lines.push(`  ${capture.status === 'changed' ? '~' : '+'} ${capture.storyId} @${capture.width}  ${detail}`);
      if (capture.status === 'render-failed' || capture.status === 'failed') {
        for (const line of (capture.error ?? '').split('\n').slice(0, 2)) {
          if (line.trim()) lines.push(`      ${line.trim()}`);
        }
      }
    }

    if (counts.length > 1) lines.push('');
    lines.push(`  report   ${show(reportPath)}`, `  summary  ${show(summaryPath)}`);

    if (summary.changedStories.length > 0 && summary.mode === 'run') {
      lines.push('', '  Accept as the new baseline:  npx diopsis accept');
    }
    lines.push('');
    process.stdout.write(lines.join('\n'));
  }
}
