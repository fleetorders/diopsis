export {
  defaultConfig,
  defineConfig,
  loadConfig,
  resolveConfig,
  supportsTypeStripping,
  CONFIG_FILENAMES,
} from './config.ts';
export type {
  CompareOptions,
  DiopsisConfig,
  LoadedConfig,
  StabilizeOptions,
  UserConfig,
} from './config.ts';

export { parseStoryIndex, readStoryIndex } from './story-index.ts';
export type { StoryEntry } from './story-index.ts';

export {
  parseSnapshotPath,
  platformToken,
  resolveMatrix,
  scopeForStory,
  snapshotPathFor,
  statesForStory,
  widthsForStory,
} from './matrix.ts';
export type { Capture, InteractionState, ParsedSnapshotPath, ResolvedMatrix } from './matrix.ts';

export { serveStatic, storyUrlFor } from './server.ts';
export type { StaticServer } from './server.ts';

export { runCommand } from './commands/run.ts';
export type { RunOptions } from './commands/run.ts';

export { diffCommand } from './commands/diff.ts';
export type { DiffOptions } from './commands/diff.ts';
