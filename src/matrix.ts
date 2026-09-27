import type { CompareOptions, DiopsisConfig } from './config.ts';
import type { StoryEntry } from './story-index.ts';

/**
 * An interaction state a story is photographed in: one element hovered, focused or pressed,
 * held by the browser itself for the shutter. Play functions cover scripted interactions
 * (DECISIONS.md D-031); this is for the pointer and keyboard states a play function cannot
 * still be holding when the screenshot is taken.
 */
export interface InteractionState {
  /** The capture's name in paths, titles and the report: `hover`, then `hover-2`, … */
  name: string;
  action: 'hover' | 'focus' | 'active';
  /** Everything after the first `=` in the tag, spaces and further `=` included. */
  selector: string;
}

/** One screenshot: a story at a width. Captures are the unit that costs, not stories. */
export interface Capture {
  storyId: string;
  storyName: string;
  storyTitle: string;
  importPath?: string;
  width: number;
  height: number;
  /** What this capture frames: the whole page, or the rendered component alone. */
  scope: 'page' | 'component';
  /**
   * The configured mode this capture runs under — its set of Storybook globals. Absent
   * means the base capture, which always exists and is not a mode.
   */
  mode?: string;
  /** The interaction state this capture holds; absent for the plain capture. */
  state?: InteractionState;
  /** Comparison overrides the story's tags set; only the keys a tag actually carried. */
  compare?: Partial<CompareOptions>;
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

/**
 * The tolerance directives: `diopsis:<key>=<value>`, overriding the comparison for one
 * story through the same channel as the widths (DECISIONS.md §8/D-014 — the index
 * serialises tags, so tags are the only per-story setting that cannot drift). They are not
 * widths and never take part in width resolution.
 */
const TOLERANCE_KEYS: Record<string, { option: keyof CompareOptions; unit: boolean }> = {
  threshold: { option: 'threshold', unit: true },
  'max-diff-ratio': { option: 'maxDiffPixelRatio', unit: true },
  'max-diff-pixels': { option: 'maxDiffPixels', unit: false },
};

/** One tolerance directive, split into the compare option it overrides and its raw value. */
function toleranceDirective(
  token: string,
): { option: keyof CompareOptions; unit: boolean; value: string } | undefined {
  const eq = token.indexOf('=');
  if (eq === -1) return undefined;
  const spec = TOLERANCE_KEYS[token.slice(0, eq)];
  return spec ? { ...spec, value: token.slice(eq + 1) } : undefined;
}

/** `0..1` for the two ratio knobs, a whole pixel count for `max-diff-pixels`. */
function parseToleranceValue(value: string, unit: boolean): number | undefined {
  if (unit) {
    if (!/^\d+(\.\d+)?$/.test(value)) return undefined;
    const parsed = Number(value);
    return parsed <= 1 ? parsed : undefined;
  }
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

/**
 * Tolerance overrides for one story, from its tags. A malformed value — not a number, or
 * out of range — warns through the same channel as an unrecognised tag and is ignored,
 * so a typo costs a warning, never the run.
 */
export function toleranceForStory(
  story: StoryEntry,
): { compare?: Partial<CompareOptions>; warnings: string[] } {
  const compare: Partial<CompareOptions> = {};
  const warnings: string[] = [];
  for (const directive of story.tags) {
    if (!directive.startsWith(TAG_PREFIX)) continue;
    const parsed = toleranceDirective(directive.slice(TAG_PREFIX.length));
    if (!parsed) continue;
    const value = parseToleranceValue(parsed.value, parsed.unit);
    if (value === undefined) {
      warnings.push(
        `${story.id}: tag "${directive}" is not ` +
          (parsed.unit ? 'a number between 0 and 1' : 'a non-negative integer') +
          ' — ignored.',
      );
      continue;
    }
    compare[parsed.option] = value;
  }
  return { ...(Object.keys(compare).length > 0 ? { compare } : {}), warnings };
}

/**
 * The scope directives: `diopsis:component` photographs the rendered component rather than
 * the whole page; `diopsis:page` pins one story of a component-configured run back to the
 * page. Like the tolerance directives they name no width and never take part in width
 * resolution.
 */
const SCOPE_TAGS: Record<string, 'page' | 'component'> = {
  component: 'component',
  page: 'page',
};

/**
 * The capture scope for one story: its tags' directive over the configured default. A story
 * carrying both directives is ambiguous, so the conflict is a warning and the page wins —
 * the whole page is the capture a reader expects when the tags disagree.
 */
export function scopeForStory(
  story: StoryEntry,
  capture: 'page' | 'component',
): { scope: 'page' | 'component'; warnings: string[] } {
  let found: 'page' | 'component' | undefined;
  let conflict = false;
  for (const tag of story.tags) {
    if (!tag.startsWith(TAG_PREFIX)) continue;
    const scope = SCOPE_TAGS[tag.slice(TAG_PREFIX.length)];
    if (!scope) continue;
    if (found !== undefined && found !== scope) conflict = true;
    found = scope;
  }
  if (conflict) {
    return {
      scope: 'page',
      warnings: [
        `${story.id}: tags "diopsis:page" and "diopsis:component" both set — "page" wins.`,
      ],
    };
  }
  return { scope: found ?? capture, warnings: [] };
}

/**
 * The mode directives: `diopsis:modes=<a>,<b>` restricts a story to those configured modes
 * (the base capture always runs), `diopsis:modes=none` leaves the base capture alone. They
 * name no width and never take part in width resolution.
 */
function modesDirective(token: string): boolean {
  return token.startsWith('modes=');
}

/**
 * The modes a story is captured in beyond the base: the configured set, narrowed by the
 * story's `diopsis:modes` tag. A tag naming an unconfigured mode warns through the same
 * channel as every other tag and is ignored — a typo must cost a warning, never the run.
 * The result keeps the configured order, so capture order is stable between runs.
 */
export function modesForStory(
  story: StoryEntry,
  configured: Record<string, Record<string, string>> | undefined,
): { modes: string[]; warnings: string[] } {
  const names = configured === undefined ? [] : Object.keys(configured);
  if (configured === undefined || names.length === 0) {
    const warnings = story.tags
      .filter((tag) => tag.startsWith(TAG_PREFIX) && modesDirective(tag.slice(TAG_PREFIX.length)))
      .map(
        (tag) =>
          `${story.id}: tag "${tag}" names modes but none are configured ` +
          '(add them under `modes` in the config).',
      );
    return { modes: [], warnings };
  }

  const selected = new Set<string>();
  const warnings: string[] = [];
  let restricted = false;
  for (const tag of story.tags) {
    if (!tag.startsWith(TAG_PREFIX)) continue;
    const token = tag.slice(TAG_PREFIX.length);
    if (!modesDirective(token)) continue;
    restricted = true;
    if (token === 'modes=none') continue;
    const listed = token.slice('modes='.length).split(',').map((name) => name.trim());
    const unknown = listed.filter((name) => !name || !(name in configured));
    if (unknown.length > 0) {
      warnings.push(
        `${story.id}: tag "${tag}" names ${unknown.length === 1 ? 'a mode' : 'modes'} ` +
          `not configured: ${unknown.join(', ')} (known: ${names.join(', ')}).`,
      );
    }
    for (const name of listed) if (name in configured) selected.add(name);
  }
  return { modes: restricted ? names.filter((name) => selected.has(name)) : names, warnings };
}

/** The pointer and keyboard states a tag can ask for, keyed by the tag's own name. */
const STATE_ACTIONS: Record<string, InteractionState['action']> = {
  hover: 'hover',
  focus: 'focus',
  active: 'active',
};

/** One state directive, split into the action it asks for and the selector it aims at. */
function stateDirective(
  token: string,
): { action: InteractionState['action']; selector: string } | undefined {
  const eq = token.indexOf('=');
  if (eq === -1) return undefined;
  const action = STATE_ACTIONS[token.slice(0, eq)];
  return action ? { action, selector: token.slice(eq + 1) } : undefined;
}

/**
 * The interaction states one story is photographed in beyond its plain capture:
 * `diopsis:hover=<selector>`, `diopsis:focus=<selector>` and `diopsis:active=<selector>`,
 * one extra capture each per width and per mode. The selector is everything after the
 * first `=` — spaces and further `=` included — and may name nothing, which warns through
 * the same channel as every other unusable tag and adds no capture. Tags of the same kind
 * number themselves in tag order: `hover`, then `hover-2`, then `hover-3`.
 */
export function statesForStory(story: StoryEntry): {
  states: InteractionState[];
  warnings: string[];
} {
  const states: InteractionState[] = [];
  const warnings: string[] = [];
  const seen: Partial<Record<InteractionState['action'], number>> = {};
  for (const directive of story.tags) {
    if (!directive.startsWith(TAG_PREFIX)) continue;
    const parsed = stateDirective(directive.slice(TAG_PREFIX.length));
    if (!parsed) continue;
    if (parsed.selector.trim().length === 0) {
      warnings.push(`${story.id}: tag "${directive}" names no selector — ignored.`);
      continue;
    }
    const nth = (seen[parsed.action] ?? 0) + 1;
    seen[parsed.action] = nth;
    states.push({
      name: nth === 1 ? parsed.action : `${parsed.action}-${nth}`,
      action: parsed.action,
      selector: parsed.selector,
    });
  }
  return { states, warnings };
}

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

export function snapshotPathFor(
  storyId: string,
  width: number,
  platform = platformToken(),
  mode?: string,
  state?: string,
): string {
  const segment = safeSegment(storyId);
  // The base path is untouched by the mode and state parameters: existing baselines stay
  // valid the day either is switched on, and each gets its own file beside them.
  const middle = [mode, state].filter((part) => part !== undefined).join('-');
  return middle === ''
    ? `${segment}/${width}w-${platform}.png`
    : `${segment}/${width}w-${middle}-${platform}.png`;
}

export interface ParsedSnapshotPath {
  /** The path's directory segment: the story id as `safeSegment` wrote it. */
  storyId: string;
  width: number;
  /** The mode the baseline was captured under; absent for the base capture. */
  mode?: string;
  /** The state name the baseline was captured in; absent for the plain capture. */
  state?: string;
  platform: string;
}

/**
 * Read a baseline path back into what it names — the inverse of `snapshotPathFor`, kept
 * beside it so the two cannot drift. `diff` has nothing but the paths git reports, so
 * every story, width, mode and platform it shows comes out of this parse. `storyId` is
 * the segment, not the id that was folded into it: a parse cannot unfold what
 * `safeSegment` never wrote. Anything the matrix would not have written there returns
 * undefined.
 */
export function parseSnapshotPath(relative: string): ParsedSnapshotPath | undefined {
  const slash = relative.lastIndexOf('/');
  const segment = slash === -1 ? '' : relative.slice(0, slash);
  const filename = slash === -1 ? relative : relative.slice(slash + 1);
  // A baseline always sits inside its story's directory, and is always a PNG.
  if (!segment || !filename.endsWith('.png')) return undefined;
  const stem = filename.slice(0, -'.png'.length);
  const width = /^(\d+)w-/.exec(stem);
  if (!width) return undefined;
  // The platform token is the final two dash-separated words — a platform and an
  // architecture, neither of which contains a dash — and whatever lies between it and the
  // width is the mode, then the state, either or both absent. The state is read off the
  // tail because its names are a fixed vocabulary (`hover`, `focus`, `active`, and
  // `hover-2`…) while a mode's are free: a mode named to end in a state's name cannot be
  // told from a mode plus a state, and the state reading wins — the same order the writer
  // above lays them down in.
  const parts = stem.slice(width[0].length).split('-');
  if (parts.length < 2) return undefined;
  const platform = parts.slice(-2).join('-');
  const remainder = parts.slice(0, -2).join('-');
  const state = /^(?:(.*)-)?(hover|focus|active)(?:-([2-9]\d*))?$/.exec(remainder);
  // A state match eats the tail of the remainder; what it leaves, or the whole remainder
  // when nothing matched, is the mode.
  const mode = state ? state[1] : remainder === '' ? undefined : remainder;
  return {
    storyId: segment,
    width: Number.parseInt(width[1] ?? '', 10),
    ...(mode !== undefined ? { mode } : {}),
    ...(state ? { state: state[3] !== undefined ? `${state[2] ?? ''}-${state[3]}` : state[2] ?? '' } : {}),
    platform,
  };
}

/**
 * Widths for one story.
 *
 * Overrides come from story tags rather than a hand-maintained map: the index serializes
 * `tags` but not `parameters`, so any external map drifts silently (DECISIONS.md §8). A tag
 * is either a literal width (`diopsis:1280`) or the name of a viewport set (`diopsis:mobile`);
 * tolerance tags (`diopsis:threshold=…`) name comparison knobs instead and are resolved by
 * `toleranceForStory`.
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
    // A tolerance directive names a comparison knob, not a width; skipping it here is what
    // keeps a story carrying only tolerance tags on the default widths. The scope, mode and
    // state directives are the same kind: they name what the camera frames, under which
    // globals, and holding which interaction.
    if (toleranceDirective(token) || SCOPE_TAGS[token] || modesDirective(token) || stateDirective(token)) continue;
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
  config: Pick<DiopsisConfig, 'viewports' | 'viewportHeight' | 'capture' | 'modes'>,
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
    const tolerance = toleranceForStory(story);
    const scope = scopeForStory(story, config.capture);
    const modeSet = modesForStory(story, config.modes);
    const stateSet = statesForStory(story);
    warnings.push(
      ...resolved.warnings,
      ...tolerance.warnings,
      ...scope.warnings,
      ...modeSet.warnings,
      ...stateSet.warnings,
    );
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
      const base = {
        storyId: story.id,
        storyName: story.name,
        storyTitle: story.title,
        ...(story.importPath ? { importPath: story.importPath } : {}),
        width,
        height: config.viewportHeight,
        scope: scope.scope,
        ...(tolerance.compare ? { compare: tolerance.compare } : {}),
      };
      // The base capture first, then its interaction states, then the same shape per mode:
      // the order of the review list and the plan, and the shape of every path a baseline
      // can live at. A state multiplies the capture set like a width and a mode do, so the
      // plain capture always remains beside the ones holding an element hovered, focused
      // or pressed.
      captures.push({ ...base, snapshotPath: snapshotPathFor(story.id, width, platform) });
      for (const state of stateSet.states) {
        captures.push({
          ...base,
          state,
          snapshotPath: snapshotPathFor(story.id, width, platform, undefined, state.name),
        });
      }
      for (const mode of modeSet.modes) {
        captures.push({
          ...base,
          mode,
          snapshotPath: snapshotPathFor(story.id, width, platform, mode),
        });
        for (const state of stateSet.states) {
          captures.push({
            ...base,
            mode,
            state,
            snapshotPath: snapshotPathFor(story.id, width, platform, mode, state.name),
          });
        }
      }
    }
  }

  return { captures, skipped, unwatched, warnings };
}

/**
 * The comparison one capture runs with.
 *
 * Playwright applies the stricter of a pixel count and a ratio when both are given, and the
 * configured ratio is always set — so a story's `max-diff-pixels` merged over it could only
 * ever tighten the check. A story that sets either count-based limit therefore replaces both
 * configured ones; its threshold overrides the configured threshold on its own.
 */
export function effectiveCompare(
  base: CompareOptions,
  override: Partial<CompareOptions> | undefined,
): CompareOptions {
  if (!override) return base;
  const ownCount =
    override.maxDiffPixels !== undefined || override.maxDiffPixelRatio !== undefined;
  const counts = ownCount ? override : base;
  return {
    threshold: override.threshold ?? base.threshold,
    ...(counts.maxDiffPixelRatio === undefined ? {} : { maxDiffPixelRatio: counts.maxDiffPixelRatio }),
    ...(counts.maxDiffPixels === undefined ? {} : { maxDiffPixels: counts.maxDiffPixels }),
  } as CompareOptions;
}

/** A shard of a run: `--shard 2/4` captures the second of four parts. */
export interface ShardSpec {
  index: number;
  total: number;
}

/**
 * `--shard`'s value: `<i>/<n>`, two integers with 1 ≤ i ≤ n. Anything else is undefined, so
 * the CLI can name the value it refused rather than guessing at the intent behind it.
 */
export function parseShard(text: string): ShardSpec | undefined {
  const match = /^(\d+)\/(\d+)$/.exec(text.trim());
  if (!match) return undefined;
  const index = Number.parseInt(match[1] ?? '', 10);
  const total = Number.parseInt(match[2] ?? '', 10);
  return index >= 1 && index <= total ? { index, total } : undefined;
}

/**
 * This shard's part of a capture plan.
 *
 * Stories are assigned whole — a story split across shards is a story reviewed twice, and
 * its captures belong together wherever they are reviewed — over the stories sorted by id,
 * each to the shard with the fewest captures so far. The split is therefore deterministic
 * (any machine computing it gets the same answer) and stays balanced within one story's
 * capture count, the most any single assignment can move the balance. The returned
 * captures keep the plan's own order.
 */
export function shardCaptures(captures: Capture[], index: number, total: number): Capture[] {
  const byStory = new Map<string, Capture[]>();
  for (const capture of captures) {
    const own = byStory.get(capture.storyId);
    if (own) own.push(capture);
    else byStory.set(capture.storyId, [capture]);
  }

  const loads = Array.from({ length: total }, () => 0);
  const assigned = Array.from({ length: total }, () => [] as string[]);
  for (const id of [...byStory.keys()].sort()) {
    // The least-loaded shard, ties to the lowest index: same plan in, same split out.
    let least = 0;
    for (let shard = 1; shard < total; shard++) {
      if (loads[shard]! < loads[least]!) least = shard;
    }
    loads[least] = loads[least]! + byStory.get(id)!.length;
    assigned[least]!.push(id);
  }

  const mine = new Set(assigned[index - 1] ?? []);
  return captures.filter((capture) => mine.has(capture.storyId));
}

/** How many differing pixels a comparison lets through on an image of `area` pixels. */
function allowance(compare: Partial<CompareOptions>, area: number): number {
  return Math.min(
    compare.maxDiffPixels ?? Infinity,
    compare.maxDiffPixelRatio === undefined ? Infinity : compare.maxDiffPixelRatio * area,
  );
}

/**
 * The stories whose tags compare more loosely than the configured comparison — a higher
 * threshold, ratio or differing-pixel count. Per-story tolerance exists for the odd story
 * that cannot be deterministic, so the run header and `doctor` surface every use of it: a
 * widened tolerance nobody can see becomes the suite's quiet default.
 *
 * Count limits are judged at the capture's own frame. A page capture is compared at its
 * viewport, where a pixel count and a ratio become comparable once an image size is fixed.
 * A component capture compares a clip far smaller than its viewport — often by an order of
 * magnitude — so the viewport's area would measure the override against pixels that are not
 * in the image and a count dozens of times looser on the clip can look tighter than the
 * config. For those the knobs are compared directly, an unset limit reading as unbounded.
 */
export function loosenedStoryIds(captures: Capture[], compare: CompareOptions): string[] {
  const ids = new Set<string>();
  for (const capture of captures) {
    const override = capture.compare;
    if (!override) continue;
    const effective = effectiveCompare(compare, override);
    const area = capture.width * capture.height;
    const looser =
      effective.threshold > compare.threshold ||
      (capture.scope === 'component'
        ? (effective.maxDiffPixelRatio ?? Infinity) > (compare.maxDiffPixelRatio ?? Infinity) ||
          (effective.maxDiffPixels ?? Infinity) > (compare.maxDiffPixels ?? Infinity)
        : allowance(effective, area) > allowance(compare, area));
    if (looser) ids.add(capture.storyId);
  }
  return [...ids].sort();
}
