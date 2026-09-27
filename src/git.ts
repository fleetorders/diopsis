import { spawnSync } from 'node:child_process';

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

/**
 * Ask git's own ignore rules about one path. `check-ignore` answers for every source of
 * ignores — .gitignore at any level, .git/info/exclude, the global config — where a string
 * comparison sees only one file's exact lines. Undefined when git could not answer, so the
 * caller can fall back rather than guess.
 */
export function gitIgnores(cwd: string, target: string): boolean | undefined {
  const status = spawnSync('git', ['check-ignore', '-q', '--', target], {
    cwd,
    env: gitEnv,
    stdio: 'ignore',
  }).status;
  if (status === 0) return true;
  if (status === 1) return false;
  return undefined;
}
