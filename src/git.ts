import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { displayPath } from './paths.ts';

// Git exports GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR to hooks, absolute inside a linked
// worktree, and a child git prefers them over `cwd` — an inherited environment would make
// the child act on whichever repository launched us, not the directory we chose. Strip the
// whole prefix so `cwd` is the only authority on which repository we touch.
export const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

/** Whether `cwd` sits inside a git working tree, asked of git with the stripped environment. */
export function isGitRepo(cwd: string): boolean {
  return (
    spawnSync('git', ['rev-parse', '--git-dir'], { cwd, env: gitEnv, stdio: 'ignore' })
      .status === 0
  );
}

/** Whether git can resolve `ref` in `cwd`, quiet either way. */
export function refExists(cwd: string, ref: string): boolean {
  return (
    spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, env: gitEnv, stdio: 'ignore' })
      .status === 0
  );
}

/** Run git in `cwd` and return its stdout lines, or undefined when git itself failed. */
export function gitLines(cwd: string, args: string[]): string[] | undefined {
  const run = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  if (run.status !== 0 || run.error) return undefined;
  return run.stdout.split('\n').filter((line) => line.length > 0);
}

/**
 * Where `cwd` sits inside its repository, as git spells it — `packages/app` for a project in
 * a directory of a larger repository, '' at the top level or outside any repository. Paths
 * git lists are relative to the top level, so this is what joins them to the project's own.
 */
export function gitPrefix(cwd: string): string {
  return (gitLines(cwd, ['rev-parse', '--show-prefix'])?.[0] ?? '').replace(/\/+$/, '');
}

/** One ignore rule git named for a path it ignores. */
export interface IgnoreRule {
  /** The file the rule lives in, relative to `cwd` — `../.gitignore` names a parent's. */
  source: string;
  /** The pattern's one-based line inside that file. */
  line: number;
  /** The pattern as written, delimiters and all. */
  pattern: string;
}

/**
 * Ask git's own ignore rules about one path and name the rule that ignores it. The
 * `--verbose` form prints `<source>:<line>:<pattern>\t<path>`, and the source is
 * relative to the repository root — which can sit above `cwd`, as it does for any project
 * inside a directory of a larger repository — so it is resolved against the top level and
 * made relative to `cwd` again: a parent directory's rule reads as one. False when
 * nothing ignores the path, undefined when git could not answer.
 */
export function gitIgnoreRule(cwd: string, target: string): IgnoreRule | false | undefined {
  const run = spawnSync('git', ['check-ignore', '-v', '--', target], {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
  });
  if (run.status === 1) return false;
  if (run.status !== 0 || run.error) return undefined;
  const meta = (run.stdout.split('\n')[0] ?? '').split('\t')[0] ?? '';
  const first = meta.indexOf(':');
  const second = meta.indexOf(':', first + 1);
  if (first === -1 || second === -1) return undefined;
  const source = meta.slice(0, first);
  const line = Number.parseInt(meta.slice(first + 1, second), 10);
  const pattern = meta.slice(second + 1);
  if (!source || !Number.isInteger(line) || line < 1 || !pattern) return undefined;
  if (path.isAbsolute(source)) return { source, line, pattern };
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
  });
  // Without the top level the source still names the file, if less helpfully.
  if (top.status !== 0 || top.error) return { source, line, pattern };
  // Git resolves symlinks on its way to the top level, so the two ends of the comparison
  // have to sit in the same tree: a cwd reached through a symlink would otherwise
  // relativize against a physical path it cannot reach with any number of "..".
  let base = cwd;
  try {
    base = realpathSync(cwd);
  } catch {
    // Git answered for this directory, so the fallback is unreachable in practice.
  }
  return {
    source: displayPath(base, path.resolve(top.stdout.trim(), source)),
    line,
    pattern,
  };
}

/**
 * Ask git's own ignore rules about one path. `check-ignore` answers for every source of
 * ignores — .gitignore at any level, .git/info/exclude, the global config — where a string
 * comparison sees only one file's exact lines. Undefined when git could not answer, so the
 * caller can fall back rather than guess.
 */
export function gitIgnores(cwd: string, target: string): boolean | undefined {
  const rule = gitIgnoreRule(cwd, target);
  return rule ? true : rule === false ? false : undefined;
}
