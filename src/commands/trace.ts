import { existsSync } from 'node:fs';
import path from 'node:path';

import { readPreviewStats, traceFile } from '../affected.ts';
import { loadConfig } from '../config.ts';
import { readStoryIndex } from '../story-index.ts';

export interface TraceOptions {
  root: string;
  /** Files to trace, named relative to the project root or absolute. */
  files: string[];
}

/**
 * Show how a change to each named file reaches stories: the importer chain from the file
 * to a story file, then the stories living in it. This is the same resolver `--changed`
 * decides with, so what it prints is what a run would do — including the reason a file
 * forces the full matrix, which is often the thing actually being asked about.
 */
export async function traceCommand(options: TraceOptions): Promise<number> {
  const { config } = await loadConfig(options.root);
  const storybookDir = path.resolve(options.root, config.storybookDir);

  if (!existsSync(storybookDir)) {
    process.stderr.write(
      `No Storybook build at ${config.storybookDir}. Build it first, or point ` +
        `storybookDir at the build output.\n`,
    );
    return 1;
  }

  const stories = await readStoryIndex(storybookDir);
  const stats = await readPreviewStats(storybookDir);

  const lines: string[] = [];
  for (const given of options.files) {
    // Files are named as on the command line; the graph knows them root-relative, so an
    // absolute or dotted path is folded onto that base before it is asked about.
    const file = path
      .relative(options.root, path.resolve(options.root, given))
      .replace(/\\/g, '/');
    lines.push(`${given}:`);

    const outcome = traceFile({
      file,
      stories,
      ...(stats ? { stats } : {}),
    });
    if (outcome.kind === 'full') {
      lines.push(`  full run — ${outcome.reason}`);
      continue;
    }
    if (outcome.kind === 'none') {
      lines.push('  no story reaches this file');
      continue;
    }
    for (const { chain, storyIds } of outcome.chains) {
      lines.push(`  ${chain.join(' → ')} → ${storyIds.join(', ')}`);
    }
    if (outcome.more) lines.push('  … more chains than shown');
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
