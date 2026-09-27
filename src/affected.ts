import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { CONFIG_FILENAMES } from './config.ts';

/**
 * Change-aware capture: which stories a change could possibly reach.
 *
 * The build's own module graph is the only witness that can prove a story unaffected, and
 * every Storybook builder writes it: `storybook build --stats-json` leaves a
 * `preview-stats.json` beside the story index, holding one reverse edge per module — the
 * `reasons`, its importers. Everything here is a walk over that graph seeded with the
 * files a diff names, under one rule that outlives every edge case: whatever cannot be
 * proven affected is captured. A graph that does not describe this build, a changed file
 * the graph does not know, a missing stats file — each degrades to a full run, never to a
 * skip (DECISIONS.md §4).
 */

/** One module of the stats file, as the Vite and the Webpack builder both write it. */
export interface StatsModule {
  id?: string | number;
  name?: string;
  /** Members of a concatenated module (webpack): each name is a file path in its own right. */
  modules?: StatsModule[];
  /** Reverse edges: the modules importing this one. */
  reasons?: { moduleName?: string }[];
}

/** The whole `preview-stats.json` — a list of modules and nothing else that matters here. */
export interface PreviewStats {
  modules?: StatsModule[];
}

/** The half of the story index the graph join needs. */
export interface AffectedStory {
  id: string;
  /** Project-relative path of the story's file; the oldest indexes carry none. */
  importPath?: string;
}

export interface AffectedOptions {
  /** Storybook's config directory, project-relative. Default `.storybook`. */
  configDir?: string;
  /** Storybook's static directories, project-relative: any change inside one is global. */
  staticDirs?: string[];
  /** File names that reshape every capture, project-relative. Default: Diopsis's own. */
  configFiles?: string[];
  /** Globs removed from the changed set before classification, project-relative. */
  ignore?: string[];
}

/** The decision: run everything, or the provable subset. */
export type AffectedResult =
  | { kind: 'full'; reason: string }
  | { kind: 'set'; storyIds: string[]; traces: Record<string, string[]> };

export interface NormalisedName {
  /**
   * A virtual or builder-internal module (`virtual:…`, `/virtual:…`, `(webpack)…`). No git
   * path can ever equal one, so they take part in the walk but never match a changed file.
   */
  virtual: boolean;
  /** Repo-root-relative POSIX path for file modules; the kept name for virtual ones. */
  path: string;
}

/** The concatenated-module suffix webpack appends to a group of modules it folded into one. */
const CONCATENATED = /\s*\+\s*\d+\s+modules?$/;

function cleanDir(dir: string): string {
  let out = dir.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  if (out === '.') return '';
  return out.replace(/\/+$/, '');
}

function joinPosix(base: string, relative: string): string {
  const prefix = cleanDir(base);
  return prefix ? `${prefix}/${relative}` : relative;
}

/**
 * One spelling for both sides of every comparison.
 *
 * Builder names and story `importPath`s are project-relative, `./`-prefixed, sometimes
 * query-suffixed, sometimes carrying webpack's concatenated-module suffix or Windows
 * separators; changed paths come from git, repo-root-relative and POSIX already. Each side
 * is normalised to the latter, joined under the Storybook project directory for monorepos
 * where a wrong guess collapses into the sanity check's full run rather than a wrong skip.
 */
export function normaliseModuleName(raw: string, projectDir = ''): NormalisedName {
  let name = raw.replace(/\\/g, '/').replace(CONCATENATED, '');
  const query = name.indexOf('?');
  if (query !== -1) name = name.slice(0, query);
  const virtual =
    name.startsWith('virtual:') || name.startsWith('/virtual:') || name.startsWith('(');
  while (name.startsWith('./')) name = name.slice(2);
  return { virtual, path: virtual ? name : joinPosix(projectDir, name) };
}

/**
 * The changed files the ignore globs leave in — the set a decision was made against, in the
 * one spelling every comparison relies on. The count a run reports must be of this set, not
 * the raw diff: a run's own output is ignored by classification but changes with every shard
 * that finishes, so shards of one run agree about their decision only when they count it.
 */
export function consideredFiles(files: string[], patterns: string[]): string[] {
  // Changed paths go through the same normaliser as graph names — git paths arrive plain,
  // but one spelling for both sides is the invariant every match below relies on.
  return [...new Set(files.map((file) => normaliseModuleName(file).path))]
    .filter((file) => !patterns.some((pattern) => matchesGlob(file, pattern)))
    .sort();
}

/**
 * A minimal glob: `*` within one segment, `**` across them, everything else literal.
 * Changed sets are small, so compiling per match beats caching compiled forms.
 */
function matchesGlob(target: string, pattern: string): boolean {
  let source = '';
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at]!;
    if (char !== '*') {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      continue;
    }
    if (pattern[at + 1] !== '*') {
      source += '[^/]*';
      continue;
    }
    while (pattern[at + 1] === '*') at += 1;
    // `**/` is any number of whole segments, including none; a bare `**` is anything.
    if (pattern[at + 1] === '/') {
      source += '(?:[^/]+/)*';
      at += 1;
    } else {
      source += '.*';
    }
  }
  return new RegExp(`^${source}$`).test(target);
}

const LOCKFILES =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.lock)$/;
const BUILDER_CONFIGS = /(?:^|\/)(?:vite|webpack|postcss|tailwind)\.config\.[cm]?[jt]s$/;

interface ResolvedAffectedOptions {
  configDir: string;
  staticDirs: string[];
  configFiles: string[];
  ignore: string[];
}

function resolveAffectedOptions(
  options: AffectedOptions | undefined,
  projectDir: string,
): ResolvedAffectedOptions {
  return {
    configDir: joinPosix(projectDir, options?.configDir ?? '.storybook'),
    staticDirs: (options?.staticDirs ?? []).map((dir) => joinPosix(projectDir, dir)),
    configFiles: (options?.configFiles ?? [...CONFIG_FILENAMES]).map((file) =>
      joinPosix(projectDir, file),
    ),
    ignore: (options?.ignore ?? []).map((pattern) => joinPosix(projectDir, pattern)),
  };
}

/**
 * The changes no module graph can reason about, checked before the graph is trusted: each
 * reshapes every render, so the honest result is the whole matrix. The first hit wins, in
 * the changed set's sorted order, so the stated reason is stable between runs.
 */
function fullRunReasonFor(file: string, options: ResolvedAffectedOptions): string | undefined {
  if (file === options.configDir || file.startsWith(`${options.configDir}/`)) {
    return `${file} is in the Storybook config directory (${options.configDir})`;
  }
  if (options.configFiles.includes(file)) {
    return `${file} is the Diopsis config — it can reshape every capture`;
  }
  if (/(?:^|\/)package\.json$/.test(file) || LOCKFILES.test(file)) {
    return `${file} is a package manifest or lockfile — every story's build can change`;
  }
  if (BUILDER_CONFIGS.test(file)) {
    return `${file} is a build configuration`;
  }
  for (const dir of options.staticDirs) {
    if (file === dir || file.startsWith(`${dir}/`)) {
      return `${file} is in a static directory (${dir})`;
    }
  }
  return undefined;
}

const MISSING_STATS =
  'no preview-stats.json beside the story index (storybook build --stats-json writes it)';

interface GraphNode {
  virtual: boolean;
  /** Normalised names of the modules importing this one. */
  importers: Set<string>;
}

interface ModuleGraph {
  nodes: Map<string, GraphNode>;
  /** Story ids by the normalised path of the file their importPath names. */
  storiesByModule: Map<string, string[]>;
  /**
   * Stories no graph can place — a virtual import path (a custom indexer), or none at all.
   * They are ineligible for skipping in any run: always captured.
   */
  ungraphable: string[];
}

function buildGraph(
  stories: AffectedStory[],
  stats: PreviewStats,
  projectDir: string,
): { graph: ModuleGraph } | { reason: string } {
  const nodes = new Map<string, GraphNode>();
  const nodeFor = (raw: string): GraphNode => {
    const name = normaliseModuleName(raw, projectDir);
    let node = nodes.get(name.path);
    if (!node) {
      node = { virtual: name.virtual, importers: new Set() };
      nodes.set(name.path, node);
    }
    return node;
  };

  // A malformed stats file reads as no modules at all, which the sanity check below turns
  // into a full run — never a crash on input this tool did not write.
  const modules = Array.isArray(stats.modules) ? stats.modules : [];
  for (const module of modules) {
    if (typeof module?.name !== 'string') continue;
    // Webpack folds the modules it inlines into one entry named `<file> + N modules`; each
    // member is a file in its own right, reached through the folded entry's importers.
    const node = nodeFor(module.name);
    for (const member of module.modules ?? []) {
      if (typeof member?.name !== 'string') continue;
      const name = normaliseModuleName(member.name, projectDir);
      if (!nodes.has(name.path)) nodes.set(name.path, node);
    }
    for (const reason of module.reasons ?? []) {
      if (typeof reason?.moduleName !== 'string') continue;
      node.importers.add(normaliseModuleName(reason.moduleName, projectDir).path);
    }
  }

  const storiesByModule = new Map<string, string[]>();
  const ungraphable: string[] = [];
  let missing: { path: string; id: string } | undefined;
  for (const story of stories) {
    if (!story.importPath) {
      ungraphable.push(story.id);
      continue;
    }
    const name = normaliseModuleName(story.importPath, projectDir);
    if (name.virtual) {
      ungraphable.push(story.id);
      continue;
    }
    const ids = storiesByModule.get(name.path) ?? [];
    ids.push(story.id);
    storiesByModule.set(name.path, ids);
    // The sanity check is what makes the whole walk safe: `reasons` describe the build that
    // wrote them, and a story file the graph does not list means these stats are not from
    // this build — a stale copy, another project dir, a builder quirk. A wrong skip is the
    // one failure this feature must never produce, so one miss voids the graph.
    if (missing === undefined && !nodes.has(name.path)) missing = { path: name.path, id: story.id };
  }
  if (missing) {
    return {
      reason: `${missing.path} (${missing.id}) is missing from the module graph — the stats do not describe this build`,
    };
  }

  return { graph: { nodes, storiesByModule, ungraphable } };
}


/**
 * Breadth-first over the importers, from the changed files to whatever imports them. The
 * first chain found to a story is the shortest there is; longer routes to the same story
 * add nothing a reviewer would act on. Cycles simply revisit nothing: every key enters
 * the queue at most once.
 */
function walk(seeds: string[], graph: ModuleGraph): Map<string, string[]> {
  const parent = new Map<string, string>();
  const seen = new Set(seeds);
  const queue = [...seeds];
  const chains = new Map<string, string[]>();

  for (let at = 0; at < queue.length; at += 1) {
    const key = queue[at]!;
    const reached = graph.storiesByModule.get(key);
    if (reached && reached.length > 0) {
      const chain: string[] = [];
      for (let step: string | undefined = key; step !== undefined; step = parent.get(step)) {
        chain.push(step);
      }
      chain.reverse();
      for (const id of reached) if (!chains.has(id)) chains.set(id, chain);
    }
    const node = graph.nodes.get(key);
    if (!node) continue;
    for (const importer of [...node.importers].sort()) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      parent.set(importer, key);
      queue.push(importer);
    }
  }
  return chains;
}

/**
 * Decide the capture set for a change.
 *
 * `changed` holds repo-root-relative POSIX paths; `stories` is the parsed index; `stats`
 * the parsed `preview-stats.json`, absent when the build wrote none. A full run is always
 * the answer for what the graph cannot vouch for; a `set` names the stories to shoot and,
 * for each, the import chain from a changed file that reaches it.
 */
export function resolveAffected(input: {
  changed: string[];
  stories: AffectedStory[];
  stats?: PreviewStats;
  /** The Storybook project directory relative to the repo root; '' when it is the root. */
  projectDir?: string;
  options?: AffectedOptions;
}): AffectedResult {
  const projectDir = cleanDir(input.projectDir ?? '');
  const options = resolveAffectedOptions(input.options, projectDir);

  const changed = consideredFiles(input.changed, options.ignore);

  for (const file of changed) {
    const reason = fullRunReasonFor(file, options);
    if (reason) return { kind: 'full', reason };
  }

  if (input.stats === undefined) return { kind: 'full', reason: MISSING_STATS };

  const built = buildGraph(input.stories, input.stats, projectDir);
  if ('reason' in built) return { kind: 'full', reason: built.reason };
  const { graph } = built;

  const seeds: string[] = [];
  for (const file of changed) {
    // A file the new build's graph does not list, though the diff says it exists, is
    // rendered input the graph never saw — a font, an asset, anything. The one safe answer
    // is the full matrix; deletions never arrive here because the diff filters them out.
    if (!graph.nodes.has(file)) {
      return { kind: 'full', reason: `${file} is not in the module graph — cannot prove any story unaffected` };
    }
    seeds.push(file);
  }

  const chains = walk(seeds, graph);
  const traces: Record<string, string[]> = {};
  const ids = new Set<string>(graph.ungraphable);
  for (const [id, chain] of chains) {
    ids.add(id);
    traces[id] = chain;
  }
  return { kind: 'set', storyIds: [...ids].sort(), traces };
}

export interface TraceChain {
  /** Normalised path, changed file → importer → … → story file. */
  chain: string[];
  /** The stories living in the file the chain ends at. */
  storyIds: string[];
}

export type TraceOutcome =
  | { kind: 'full'; reason: string }
  | { kind: 'none' }
  /** The file matches an ignore glob: a run drops it from the changed set before deciding. */
  | { kind: 'ignored'; pattern: string }
  | { kind: 'chains'; chains: TraceChain[]; more: boolean };

/** How many chains `trace` walks per file before the listing is cut short. */
const TRACE_CHAIN_LIMIT = 20;

/**
 * The chains from one file to the stories it reaches — the same resolver `--changed`
 * decides with, so what this reports is what a run would do, including the reason a file
 * forces the full matrix, which is often the thing being asked about.
 */
export function traceFile(input: {
  file: string;
  stories: AffectedStory[];
  stats?: PreviewStats;
  projectDir?: string;
  options?: AffectedOptions;
}): TraceOutcome {
  const projectDir = cleanDir(input.projectDir ?? '');
  const options = resolveAffectedOptions(input.options, projectDir);
  const file = normaliseModuleName(input.file).path;

  const pattern = options.ignore.find((glob) => matchesGlob(file, glob));
  if (pattern !== undefined) return { kind: 'ignored', pattern };

  const trigger = fullRunReasonFor(file, options);
  if (trigger) return { kind: 'full', reason: trigger };
  if (input.stats === undefined) return { kind: 'full', reason: MISSING_STATS };

  const built = buildGraph(input.stories, input.stats, projectDir);
  if ('reason' in built) return { kind: 'full', reason: built.reason };
  const { graph } = built;

  if (!graph.nodes.has(file)) {
    return {
      kind: 'full',
      reason: `${file} is not in the module graph — cannot prove any story unaffected`,
    };
  }

  // Every simple path from the file to a story file, importers in sorted order at each
  // fork so the listing is stable, cut off at a limit that keeps a barrel file's fan-out
  // printable. `more` says the file reaches further than shown.
  const chains: TraceChain[] = [];
  const stack: string[] = [];
  const onPath = new Set<string>();

  const descend = (key: string): boolean => {
    if (chains.length >= TRACE_CHAIN_LIMIT) return false;
    stack.push(key);
    onPath.add(key);
    const reached = graph.storiesByModule.get(key);
    if (reached && reached.length > 0) chains.push({ chain: [...stack], storyIds: reached });
    const node = graph.nodes.get(key);
    for (const importer of [...(node?.importers ?? [])].sort()) {
      if (onPath.has(importer)) continue;
      if (!descend(importer)) break;
    }
    stack.pop();
    onPath.delete(key);
    return chains.length < TRACE_CHAIN_LIMIT;
  };
  descend(file);

  if (chains.length === 0) return { kind: 'none' };
  return { kind: 'chains', chains, more: chains.length >= TRACE_CHAIN_LIMIT };
}

/**
 * The stats file beside the story index, or undefined when it is absent or not JSON: both
 * mean the build cannot be asked what it depends on, which every resolver above reports as
 * a full run. This is the module's only input/output edge; everything else is plain data.
 */
export async function readPreviewStats(storybookDir: string): Promise<PreviewStats | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(storybookDir, 'preview-stats.json'), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as PreviewStats;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}
