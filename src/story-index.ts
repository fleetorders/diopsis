import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface StoryEntry {
  id: string;
  name: string;
  title: string;
  importPath?: string;
  componentPath?: string;
  tags: string[];
}

/** Index files Storybook has written, newest first. */
const INDEX_FILENAMES = ['index.json', 'stories.json'] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Parse a Storybook story index.
 *
 * The v5 index nests entries under `entries` as an object keyed by story id, and each entry
 * carries a `type` of `story` or `docs`. Older indexes used `stories` instead of `entries`,
 * sometimes an array, and had no `type` at all — so shape detection is deliberately loose and
 * only the `docs` type is excluded outright.
 */
export function parseStoryIndex(raw: unknown): StoryEntry[] {
  const root = asRecord(raw);
  if (!root) throw new Error('Story index is not an object.');

  const container = root['entries'] ?? root['stories'];
  if (container === undefined) {
    throw new Error('Story index has neither an "entries" nor a "stories" key.');
  }

  const rawEntries: unknown[] = Array.isArray(container)
    ? container
    : Object.values(asRecord(container) ?? {});

  const stories: StoryEntry[] = [];
  for (const candidate of rawEntries) {
    const entry = asRecord(candidate);
    if (!entry) continue;

    // Absent `type` means a pre-v4 index, which listed stories only.
    const type = typeof entry['type'] === 'string' ? entry['type'] : 'story';
    if (type !== 'story') continue;

    const id = typeof entry['id'] === 'string' ? entry['id'] : undefined;
    if (!id) continue;

    stories.push({
      id,
      name: typeof entry['name'] === 'string' ? entry['name'] : id,
      title: typeof entry['title'] === 'string' ? entry['title'] : '',
      ...(typeof entry['importPath'] === 'string' ? { importPath: entry['importPath'] } : {}),
      ...(typeof entry['componentPath'] === 'string'
        ? { componentPath: entry['componentPath'] }
        : {}),
      tags: asStringArray(entry['tags']),
    });
  }

  stories.sort((a, b) => a.id.localeCompare(b.id));
  return stories;
}

export async function readStoryIndex(storybookDir: string): Promise<StoryEntry[]> {
  const tried: string[] = [];
  for (const name of INDEX_FILENAMES) {
    const file = path.join(storybookDir, name);
    tried.push(name);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // A truncated or hand-edited index surfaces as a bare parse error; naming the file
      // and the remedy saves the user from guessing which candidate file it was.
      throw new Error(
        `${path.relative(process.cwd(), file)} is not valid JSON ` +
          `(${error instanceof Error ? error.message : String(error)}). Rebuild the Storybook.`,
      );
    }
    return parseStoryIndex(parsed);
  }
  throw new Error(
    `No story index in ${storybookDir} (looked for ${tried.join(', ')}). ` +
      'Point storybookDir at the output of a Storybook build.',
  );
}
