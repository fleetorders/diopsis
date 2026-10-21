import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseSnapshotPath, snapshotPathFor, type Capture } from './matrix.ts';
import type { RunSummary } from './report/summary.ts';

/**
 * One baseline PNG on disk — the shape every question about the set (weight, orphans,
 * renames) reads it in.
 */
export interface BaselineFile {
  /** Absolute path. */
  absolute: string;
  /** Relative to the snapshot directory, with forward slashes. */
  relative: string;
  bytes: number;
  /** The platform token the filename carries; absent when it carries none. */
  platform?: string;
}

/** The platform token a baseline's filename ends in — `darwin-arm64` in `320w-…-darwin-arm64.png`. */
export function platformOf(relative: string): string | undefined {
  return /-([a-z0-9]+-[a-z0-9]+)\.png$/.exec(relative)?.[1];
}

/**
 * Every PNG under a directory, symlinks included but never followed through: a link is
 * listed as the file it claims to be, and its real location is the caller's question to
 * ask. A directory that cannot be read is simply empty — the caller decides whether that
 * is a problem.
 */
export async function walkBaselines(dir: string): Promise<BaselineFile[]> {
  const out: BaselineFile[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, relative);
      } else if (entry.name.endsWith('.png')) {
        try {
          const platform = platformOf(relative);
          out.push({
            absolute: full,
            relative,
            bytes: (await stat(full)).size,
            ...(platform ? { platform } : {}),
          });
        } catch {
          // A file that vanished or cannot be stat'd mid-walk is nothing to act on.
        }
      }
    }
  }

  await walk(dir, '');
  return out;
}

/**
 * Every baseline path the matrix would write, once per platform token named. A repository
 * keeps one set per platform, so whether a baseline is expected is a question about its
 * story, width and mode — the token only decides which copies exist. The caller chooses
 * the tokens: `doctor` judges the current platform, `prune` every platform present.
 */
export function expectedBaselines(
  captures: Capture[],
  platforms: Iterable<string>,
): Set<string> {
  const expected = new Set<string>();
  for (const platform of platforms) {
    for (const capture of captures) {
      expected.add(
        snapshotPathFor(capture.storyId, capture.width, platform, capture.mode, capture.state?.name),
      );
    }
  }
  return expected;
}

/** The files no expected path accounts for — baselines nothing would write again. */
export function orphanedBaselines(files: BaselineFile[], expected: Set<string>): BaselineFile[] {
  return files.filter((file) => !expected.has(file.relative));
}

/** The total weight of the baselines under a directory; a missing directory weighs nothing. */
export async function baselineWeight(dir: string): Promise<number> {
  const files = await walkBaselines(dir);
  return files.reduce((total, file) => total + file.bytes, 0);
}

export interface RenameHint {
  /** The orphaned baseline's story, read back from its path. */
  from: string;
  /** The story whose new baseline holds the same bytes. */
  to: string;
}

/**
 * Orphans whose bytes are identical to a baseline the last run's summary records as `new`.
 * A renamed story otherwise costs a fresh baseline plus an orphan, and naming the move
 * turns two mysteries into one review. Sizes are compared before contents, so identical
 * files cost one read each, not one read per pair. No summary, or one that names nothing
 * new, yields no hints.
 */
export async function renameHints(
  orphans: BaselineFile[],
  snapshotDir: string,
  outputDir: string,
): Promise<Map<string, RenameHint>> {
  let summary: RunSummary;
  try {
    summary = JSON.parse(await readFile(path.join(outputDir, 'summary.json'), 'utf8')) as RunSummary;
  } catch {
    return new Map();
  }
  if (!Array.isArray(summary.captures)) return new Map();

  const fresh: Array<{ storyId: string; absolute: string; bytes: number }> = [];
  for (const capture of summary.captures) {
    if (capture.status !== 'new' || typeof capture.snapshotPath !== 'string') continue;
    const absolute = path.join(snapshotDir, capture.snapshotPath);
    try {
      fresh.push({ storyId: capture.storyId, absolute, bytes: (await stat(absolute)).size });
    } catch {
      // The summary names a baseline that is not on disk; it can match nothing.
    }
  }

  const hints = new Map<string, RenameHint>();
  for (const orphan of orphans) {
    const candidates = fresh.filter(
      (f) => f.bytes === orphan.bytes && f.absolute !== orphan.absolute,
    );
    if (candidates.length === 0) continue;
    let bytes;
    try {
      bytes = await readFile(orphan.absolute);
    } catch {
      continue;
    }
    for (const candidate of candidates) {
      let contents;
      try {
        contents = await readFile(candidate.absolute);
      } catch {
        continue;
      }
      if (!bytes.equals(contents)) continue;
      hints.set(orphan.relative, {
        from:
          parseSnapshotPath(orphan.relative)?.storyId ??
          orphan.relative.slice(0, orphan.relative.lastIndexOf('/')),
        to: candidate.storyId,
      });
      break;
    }
  }
  return hints;
}
