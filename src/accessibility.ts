import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * What Diopsis does with the audit's findings. `'off'` never audits; `'report'` records
 * findings and never touches the exit code; `'fail'` makes a new finding fail the capture
 * like a change (DECISIONS.md D-042).
 */
export type AccessibilityMode = 'off' | 'report' | 'fail';

/** One axe violation, trimmed to what a review needs: the rule, and where it failed. */
export interface RawA11yViolation {
  id: string;
  impact?: string;
  help: string;
  helpUrl: string;
  /** One selector per node the rule failed on, first ten at most. */
  targets: string[];
}

/** A violation as the summary carries it: each target told apart as new or accepted. */
export interface MarkedA11yViolation {
  id: string;
  impact?: string;
  help: string;
  helpUrl: string;
  targets: Array<{ target: string; new?: true }>;
}

/**
 * Accepted findings, as `<snapshotDir>/accessibility.json` holds them — committed like
 * baselines, keyed by story (and mode, when the finding was made under one).
 */
export type AcceptedAccessibility = Record<string, Record<string, string[]>>;

export const ACCEPTED_A11Y_FILENAME = 'accessibility.json';

/** The message the run stops with when the capability is on and the library is missing. */
export const AXE_MISSING_MESSAGE =
  'accessibility is on, but axe-core is not installed: npm install --save-dev axe-core';

/**
 * Locate the tested project's axe-core. The library is an optional peer dependency
 * (DECISIONS.md D-041): it is resolved from the project being tested, never bundled, and
 * a project that has not installed it gets one line saying exactly what to install.
 */
export function resolveAxePath(root: string): string {
  const require = createRequire(path.join(root, 'package.json'));
  try {
    return require.resolve('axe-core');
  } catch {
    throw new Error(AXE_MISSING_MESSAGE);
  }
}

/** The accepted-findings key for one story's audit: `<storyId>` or `<storyId>@<mode>`. */
export function a11yKey(storyId: string, mode?: string): string {
  return mode === undefined ? storyId : `${storyId}@${mode}`;
}

/** The accepted rules and targets one capture's findings are matched against. */
export function acceptedFor(
  accepted: AcceptedAccessibility,
  storyId: string,
  mode?: string,
): Record<string, string[]> {
  return accepted[a11yKey(storyId, mode)] ?? {};
}

/** A finding is new when its rule+target is not listed for that story. */
function isNew(acceptedForStory: Record<string, string[]>, ruleId: string, target: string): boolean {
  return !(acceptedForStory[ruleId] ?? []).includes(target);
}

/**
 * Mark each target new or accepted, and count the new ones. The count is the one number
 * the summary, the terminal and the fail decision all read, so it is computed here once.
 */
export function markViolations(
  violations: RawA11yViolation[],
  acceptedForStory: Record<string, string[]>,
): { violations: MarkedA11yViolation[]; newCount: number } {
  let newCount = 0;
  const marked = violations.map((violation) => ({
    ...violation,
    targets: violation.targets.map((target) => {
      if (!isNew(acceptedForStory, violation.id, target)) return { target };
      newCount += 1;
      return { target, new: true as const };
    }),
  }));
  return { violations: marked, newCount };
}

/**
 * The error a `'fail'` run fails the capture with, or undefined when every finding is
 * accepted. The opening words are the classifier's marker, so they are load-bearing.
 */
export function a11yFailureOf(
  violations: RawA11yViolation[],
  accepted: AcceptedAccessibility,
  storyId: string,
  mode?: string,
): string | undefined {
  const acceptedForStory = acceptedFor(accepted, storyId, mode);
  const rules: string[] = [];
  let count = 0;
  for (const violation of violations) {
    const fresh = violation.targets.filter(
      (target) => isNew(acceptedForStory, violation.id, target),
    ).length;
    if (fresh > 0) {
      rules.push(violation.id);
      count += fresh;
    }
  }
  if (count === 0) return undefined;
  return `New accessibility findings: ${count} in ${a11yKey(storyId, mode)} (${rules.join(', ')})`;
}

/**
 * Read the accepted-findings file. Absent means nothing was accepted yet; a file that
 * exists but is not valid JSON is refused rather than read as empty — silently accepting
 * nothing would turn every accepted finding new again in a `'fail'` run.
 */
export async function readAcceptedA11y(file: string): Promise<AcceptedAccessibility> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    // Only an absent file is an empty set; one that exists and cannot be read is refused.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `${path.basename(file)} could not be read ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as AcceptedAccessibility;
  } catch (error) {
    throw new Error(
      `${path.basename(file)} is not valid JSON ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        'Fix it or remove it, then re-run.',
    );
  }
}

/** Sorted at every level, so the file diffs only when the findings change. */
export function formatAcceptedA11y(accepted: AcceptedAccessibility): string {
  const ordered: AcceptedAccessibility = {};
  for (const key of Object.keys(accepted).sort()) {
    const rules = accepted[key] ?? {};
    ordered[key] = {};
    for (const rule of Object.keys(rules).sort()) {
      ordered[key]![rule] = [...new Set(rules[rule] ?? [])].sort();
    }
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** The captures `adoptFindings` reads: only the fields it needs, so tests stay small. */
export interface AuditedCapture {
  storyId: string;
  mode?: string;
  /** Present only on the capture the run audited — zero violations included. */
  accessibility?: { violations: MarkedA11yViolation[] };
}

/**
 * Rewrite the accepted-findings file for the stories an accept is adopting.
 *
 * A scoped story the run audited gets exactly its current findings — an audited story that
 * came back clean loses its entry, so the file never grows stale. A scoped story the run
 * never audited (nothing ran, or the audit follows the comparison and the comparison
 * failed) keeps what it had, and stories outside the scope are untouched. Undefined when
 * no scoped story was audited at all: there is nothing to adopt and the file stays as it
 * is — including when the run never audited, which is what keeps `accept` from touching
 * the file on runs made before the capability existed.
 */
export function adoptFindings(
  existing: AcceptedAccessibility,
  captures: AuditedCapture[],
  inScope: (storyId: string) => boolean,
): { next: AcceptedAccessibility; stories: number } | undefined {
  const audited = new Map<string, AuditedCapture[]>();
  for (const capture of captures) {
    if (!capture.accessibility || !inScope(capture.storyId)) continue;
    const list = audited.get(capture.storyId);
    if (list) list.push(capture);
    else audited.set(capture.storyId, [capture]);
  }
  if (audited.size === 0) return undefined;

  const next: AcceptedAccessibility = { ...existing };
  // Stories that ended with an entry — the number the accept reports as "findings
  // accepted for N stories". A story audited clean accepted nothing, however much its
  // record was rewritten.
  let withEntries = 0;
  for (const [storyId, storyCaptures] of audited) {
    // Everything this story owns goes, entry by entry: what follows is exactly what the
    // run just found, including the absence of an entry for a mode that came back clean.
    let storyEntries = 0;
    for (const key of Object.keys(next)) {
      if (key === storyId || key.startsWith(`${storyId}@`)) delete next[key];
    }
    for (const capture of storyCaptures) {
      const rules: Record<string, string[]> = {};
      let found = 0;
      for (const violation of capture.accessibility?.violations ?? []) {
        const targets = violation.targets.map((t) => t.target);
        if (targets.length === 0) continue;
        found += targets.length;
        rules[violation.id] = [...(rules[violation.id] ?? []), ...targets];
      }
      if (found > 0) {
        next[a11yKey(storyId, capture.mode)] = rules;
        storyEntries += 1;
      }
    }
    if (storyEntries > 0) withEntries += 1;
  }
  return { next, stories: withEntries };
}
