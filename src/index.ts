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
  parseShard,
  parseSnapshotPath,
  platformToken,
  resolveMatrix,
  scopeForStory,
  shardCaptures,
  snapshotPathFor,
  statesForStory,
  widthsForStory,
} from './matrix.ts';
export type {
  Capture,
  InteractionState,
  ParsedSnapshotPath,
  ResolvedMatrix,
  ShardSpec,
} from './matrix.ts';

export { serveStatic, storyUrlFor } from './server.ts';
export type { StaticServer } from './server.ts';

export { runCommand } from './commands/run.ts';
export type { RunOptions } from './commands/run.ts';

export { diffCommand } from './commands/diff.ts';
export type { DiffOptions } from './commands/diff.ts';

export { mergeCommand } from './commands/merge.ts';
export type { MergeOptions } from './commands/merge.ts';
