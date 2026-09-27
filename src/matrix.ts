import type { DiopsisConfig } from './config.ts';
import type { StoryEntry } from './story-index.ts';

/** One screenshot: a story at a width. Captures are the unit that costs, not stories. */
export interface Capture {
  storyId: string;
  storyName: string;
  storyTitle: string;
  importPath?: string;
  width: number;
  height: number;
  /** Baseline location, relative to `snapshotDir`. */
  snapshotPath: string;
}

export interface ResolvedMatrix {
  captures: Capture[];
  /** Stories excluded by a `diopsis:skip` tag. */
  skipped: string[];
  /** Stories that resolved to no width at all, so nothing watches them. */
  unwatched: string[];
  /** Tags that looked like Diopsis directives but named nothing. `doctor` reports these. */
  warnings: string[];
}

const TAG_PREFIX = 'diopsis:';

/** `darwin-arm64`, `linux-x64` — the token that keeps two platforms' baselines apart. */
export function platformToken(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

/** Story ids are kebab-case, but a baseline path must never be able to escape its directory. */
function safeSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function snapshotPathFor(storyId: string, width: number, platform = platformToken()): string {
  return `${safeSegment(storyId)}/${width}w-${platform}.png`;
}

/**
 * Widths for one story.
 *
 * Overrides come from story tags rather than a hand-maintained map: the index serializes
 * `tags` but not `parameters`, so any external map drifts silently (DECISIONS.md §8). A tag
 * is either a literal width (`diopsis:1280`) or the name of a viewport set (`diopsis:mobile`).
 */
export function widthsForStory(
  story: StoryEntry,
  viewports: Record<string, number[]>,
): { widths: number[]; skip: boolean; warnings: string[] } {
  const directives = story.tags.filter((tag) => tag.startsWith(TAG_PREFIX));
  if (directives.length === 0) {
    return { widths: viewports['default'] ?? [], skip: false, warnings: [] };
  }

  const widths = new Set<number>();
  const warnings: string[] = [];
  let skip = false;

  for (const directive of directives) {
    const token = directive.slice(TAG_PREFIX.length);
    if (token === 'skip') {
      skip = true;
      continue;
    }
    if (/^\d+$/.test(token)) {
      widths.add(Number.parseInt(token, 10));
      continue;
    }
    const set = viewports[token];
    if (set) {
      for (const width of set) widths.add(width);
      continue;
    }
    warnings.push(
      `${story.id}: tag "${directive}" is neither a width nor a configured viewport set ` +
        `(known: ${Object.keys(viewports).join(', ') || 'none'}).`,
    );
  }

  if (skip) return { widths: [], skip: true, warnings };
  if (widths.size === 0) {
    // Every directive was unusable; fall back to the safe answer rather than capturing nothing.
    return { widths: viewports['default'] ?? [], skip: false, warnings };
  }
  return { widths: [...widths].sort((a, b) => a - b), skip: false, warnings };
}

/**
 * Expand stories into the full capture set.
 *
 * Returned as plain data, unfiltered, so change-aware capture (v2, DECISIONS.md §4) adds a
 * filter over this list rather than a second resolver.
 */
export function resolveMatrix(
  stories: StoryEntry[],
  config: Pick<DiopsisConfig, 'viewports' | 'viewportHeight'>,
  platform: string = platformToken(),
): ResolvedMatrix {
  const captures: Capture[] = [];
  const skipped: string[] = [];
  const unwatched: string[] = [];
  const warnings: string[] = [];
  // A baseline directory segment is the story id with unsafe characters replaced, so two
  // different ids can collapse onto the same segment and silently share a baseline. The
  // collision is an error the moment it happens, not a wrong diff months later.
  const owners = new Map<string, string>();

  for (const story of stories) {
    const resolved = widthsForStory(story, config.viewports);
    warnings.push(...resolved.warnings);
    if (resolved.skip) {
      skipped.push(story.id);
      continue;
    }
    if (resolved.widths.length === 0) {
      // An empty `viewports.default` is the deliberate "only tagged stories" choice; the
      // stories it leaves without widths are surfaced, never dropped quietly.
      unwatched.push(story.id);
      continue;
    }
    const segment = safeSegment(story.id);
    const owner = owners.get(segment);
    if (owner !== undefined && owner !== story.id) {
      throw new Error(
        `Stories "${owner}" and "${story.id}" both map to the baseline path "${segment}" — ` +
          'rename one of them, or the two will silently share every baseline.',
      );
    }
    owners.set(segment, story.id);
    for (const width of resolved.widths) {
      captures.push({
        storyId: story.id,
        storyName: story.name,
        storyTitle: story.title,
        ...(story.importPath ? { importPath: story.importPath } : {}),
        width,
        height: config.viewportHeight,
        snapshotPath: snapshotPathFor(story.id, width, platform),
      });
    }
  }

  return { captures, skipped, unwatched, warnings };
}
