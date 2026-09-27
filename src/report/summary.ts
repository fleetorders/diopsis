import type { CompareOptions } from '../config.ts';
import type { Region } from '../regions.ts';
import type { PlannedCapture } from '../runner/generate.ts';

/**
 * Outcome of one capture.
 *
 * These are the states a reviewer filters by (DECISIONS.md §5); they are deliberately not
 * Playwright's pass/fail, because "a baseline did not exist yet" and "this looks different"
 * both present as a failing test and need entirely different responses. `removed` is the
 * diff report's own: the branch deleted this baseline, so there is a "was" and no "is".
 */
export type CaptureStatus =
  | 'unchanged'
  | 'changed'
  | 'new'
  | 'removed'
  | 'render-failed'
  | 'failed';

export interface CaptureArtifacts {
  /** Paths relative to the summary file. */
  expected?: string;
  actual?: string;
  diff?: string;
}

export interface CaptureResult {
  storyId: string;
  storyTitle: string;
  storyName: string;
  width: number;
  status: CaptureStatus;
  /** The configured mode this capture ran under; absent for the base capture. */
  mode?: string;
  /** The interaction state this capture was taken in; absent for the plain capture. */
  state?: string;
  /** Baseline location, relative to the configured snapshot directory. */
  snapshotPath: string;
  /** Tolerance overrides in effect for this capture; present only when its story set them. */
  tolerance?: Partial<CompareOptions>;
  /** Differing pixel count, when the comparator reported one. */
  diffPixels?: number;
  /** Differing pixels as a share of the image. */
  diffRatio?: number;
  /** Pixel size of the actual render, from its PNG header. */
  size?: { width: number; height: number };
  /**
   * Where the capture changed: rectangles of differing pixels in the diff image, largest
   * first. Present only when the diff image existed and could be decoded.
   */
  regions?: Region[];
  /** Regions that existed but fell past the cap; present only when some were dropped. */
  regionsDropped?: number;
  /** Why a capture failed, when it did. */
  error?: string;
  /**
   * Present when an earlier attempt of this capture differed and a later one matched: the
   * capture is unchanged — flake between page loads, not a change — and the run says so
   * rather than reporting either a change or a quietly green pass.
   */
  unstable?: true;
  /** What the run classified the load that differed, i.e. the first attempt. */
  unstableStatus?: CaptureStatus;
  /** Differing pixels the load that differed reported, when it reported a count. */
  unstableDiffPixels?: number;
  artifacts: CaptureArtifacts;
}

export interface RunTotals {
  stories: number;
  captures: number;
  unchanged: number;
  /** Unchanged captures that differed on an earlier attempt and matched on a retry. */
  unstable: number;
  changed: number;
  new: number;
  /** Baselines the branch deleted — a diff-report verdict; a run never produces it. */
  removed: number;
  renderFailed: number;
  failed: number;
  /** Captures the run never reached — an interrupted run, not a comparison verdict. */
  notRun: number;
  /**
   * Captures a change-aware run planned but did not shoot, carried from their baselines.
   * Present only in summaries such a run wrote; they are not a comparison verdict.
   */
  carried?: number;
}

/** A capture a change-aware run planned but did not shoot; its baseline stands as it was. */
export interface CarriedCapture {
  storyId: string;
  width: number;
  /** The configured mode the capture would have run under; absent for the base capture. */
  mode?: string;
}

export interface RunSummary {
  /** Format version of this file. */
  diopsis: 1;
  createdAt: string;
  platform: string;
  arch: string;
  mode: 'run' | 'update' | 'diff';
  /** The ref a diff compared against, and the commit the two sides meet at; diff only. */
  base?: string;
  mergeBase?: string;
  /** Present (true) only when the Playwright run ended interrupted. */
  interrupted?: boolean;
  snapshotDir: string;
  totals: RunTotals;
  /** Story ids with at least one capture needing review. */
  changedStories: string[];
  /**
   * Every capture the run planned, in order — not only the interesting ones. Change-aware
   * capture (v2, DECISIONS.md §4) diffs against this to know what a previous run covered.
   */
  captures: CaptureResult[];
  /**
   * Change-aware runs: what the affected set was decided against, and — when the run shot
   * the whole matrix anyway — the reason it had to.
   */
  affected?: { base: string; mergeBase: string; changedFiles: number; full?: string };
  /** Change-aware runs: the planned captures not shot, carried from their baselines. */
  carried?: CarriedCapture[];
}

// A deleted baseline needs a reviewer's eye as much as an added one; only the diff report
// produces the status, so a run's counts are untouched by its presence here.
const REVIEWABLE: ReadonlySet<CaptureStatus> = new Set<CaptureStatus>([
  'changed',
  'new',
  'removed',
  'render-failed',
  'failed',
]);

export function needsReview(status: CaptureStatus): boolean {
  return REVIEWABLE.has(status);
}

/**
 * Error text of a capture that never ran because the run was interrupted. Carried by the
 * error rather than a new status so every consumer of `failed` keeps working unchanged.
 */
export const NOT_RUN = 'Not run: the run was interrupted.';

/** `6798 pixels (ratio 0.03 of all image pixels) are different.` */
const PIXELS_PATTERN = /([\d,]+) pixels \(ratio ([\d.]+) of all image pixels\) are different/;

const MISSING_PATTERN = /A snapshot doesn't exist at .*, writing actual/;

export interface ClassifyInput {
  passed: boolean;
  /** Concatenated error text from the Playwright result. */
  errorText: string;
  timedOut?: boolean;
  /** Baseline existence recorded by the generated spec, when the spec got that far. */
  baseline?: 'present' | 'missing';
}

/** Turn a Playwright result into the state a reviewer actually cares about. */
export function classify(input: ClassifyInput): {
  status: CaptureStatus;
  diffPixels?: number;
  diffRatio?: number;
} {
  if (input.passed) return { status: 'unchanged' };

  // A timeout produced no screenshot at all, whatever the baseline state says.
  if (input.timedOut) return { status: 'failed' };

  // A story that would not render produced no screenshot either; it is not "new".
  if (input.errorText.includes('StoryRenderError')) return { status: 'render-failed' };

  // Baseline existence is recorded by the spec itself, so classification does not ride on
  // Playwright's wording — which differs between snapshot modes ("writing actual" or not).
  if (input.baseline === 'missing') return { status: 'new' };

  if (MISSING_PATTERN.test(input.errorText)) return { status: 'new' };

  const pixels = PIXELS_PATTERN.exec(input.errorText);
  if (pixels) {
    return {
      status: 'changed',
      diffPixels: Number.parseInt((pixels[1] ?? '0').replace(/,/g, ''), 10),
      diffRatio: Number.parseFloat(pixels[2] ?? '0'),
    };
  }

  // A screenshot comparison that failed without a pixel count still changed something.
  if (input.errorText.includes('toHaveScreenshot')) return { status: 'changed' };

  return { status: 'failed' };
}

export function totalsFor(captures: CaptureResult[]): RunTotals {
  const totals: RunTotals = {
    stories: new Set(captures.map((c) => c.storyId)).size,
    captures: captures.length,
    unchanged: 0,
    unstable: 0,
    changed: 0,
    new: 0,
    removed: 0,
    renderFailed: 0,
    failed: 0,
    notRun: 0,
  };
  for (const capture of captures) {
    // Unstable captures are unchanged — the count sits beside it, not instead of it.
    if (capture.unstable) totals.unstable += 1;
    if (capture.status === 'unchanged') totals.unchanged += 1;
    else if (capture.status === 'changed') totals.changed += 1;
    else if (capture.status === 'new') totals.new += 1;
    else if (capture.status === 'removed') totals.removed += 1;
    else if (capture.status === 'render-failed') totals.renderFailed += 1;
    else if (capture.error === NOT_RUN) totals.notRun += 1;
    else totals.failed += 1;
  }
  return totals;
}

export function changedStoriesOf(captures: CaptureResult[]): string[] {
  const ids = new Set<string>();
  for (const capture of captures) {
    // A capture that did not run needs a re-run, not a review; an interrupted run must
    // not advertise changes to accept from what it never compared.
    if (capture.error === NOT_RUN) continue;
    if (needsReview(capture.status)) ids.add(capture.storyId);
  }
  return [...ids].sort();
}

/** Capture metadata keyed by the Playwright test title that produced it. */
export function indexPlanByTitle(captures: PlannedCapture[]): Map<string, PlannedCapture> {
  return new Map(captures.map((capture) => [capture.title, capture]));
}
