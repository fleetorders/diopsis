import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import {
  a11yFailureOf,
  adoptFindings,
  formatAcceptedA11y,
  markViolations,
  readAcceptedA11y,
  resolveAxePath,
  AXE_MISSING_MESSAGE,
  type AcceptedAccessibility,
  type MarkedA11yViolation,
  type RawA11yViolation,
} from '../src/accessibility.ts';
import { acceptCommand } from '../src/commands/accept.ts';
import type { CaptureResult, RunSummary } from '../src/report/summary.ts';

const temporaries: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-a11y-'));
  temporaries.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const violation = (over: Partial<RawA11yViolation> = {}): RawA11yViolation => ({
  id: 'image-alt',
  impact: 'serious',
  help: 'Images must have alternate text',
  helpUrl: 'https://example.com/rules/image-alt',
  targets: ['img.hero', 'img.logo'],
  ...over,
});

describe('resolveAxePath', () => {
  it('resolves the library this repo dev-depends on, as a spec test of the resolution', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const resolved = resolveAxePath(repo);
    assert.ok(resolved.endsWith('axe.js'), resolved);
  });

  it('refuses a project without the library, with the one line saying what to install', () => {
    // An empty temp project is a project that has not installed axe-core — the exact state
    // the message exists for.
    let thrown: Error | undefined;
    try {
      resolveAxePath(`${tmpdir()}/diopsis-a11y-absent`);
    } catch (error) {
      thrown = error as Error;
    }
    assert.equal(thrown?.message, AXE_MISSING_MESSAGE);
    assert.equal(
      AXE_MISSING_MESSAGE,
      'accessibility is on, but axe-core is not installed: npm install --save-dev axe-core',
    );
  });
});

describe('markViolations', () => {
  it('marks a rule+target new only when the accepted set does not list it', () => {
    const accepted: Record<string, string[]> = { 'image-alt': ['img.hero'] };
    const { violations, newCount } = markViolations([violation()], accepted);
    assert.deepEqual(violations[0]?.targets, [
      { target: 'img.hero' },
      { target: 'img.logo', new: true },
    ]);
    assert.equal(newCount, 1);
  });

  it('counts nothing new when everything was accepted', () => {
    const accepted: Record<string, string[]> = {
      'image-alt': ['img.hero', 'img.logo'],
      'button-name': ['button.save'],
    };
    const { newCount } = markViolations(
      [violation(), violation({ id: 'button-name', targets: ['button.save'] })],
      accepted,
    );
    assert.equal(newCount, 0);
  });
});

describe('a11yFailureOf', () => {
  const accepted: AcceptedAccessibility = {
    'card--default': { 'image-alt': ['img.hero'] },
  };

  it('names the story, the count and the rules with new findings', () => {
    const failure = a11yFailureOf([violation()], accepted, 'card--default');
    assert.equal(failure, 'New accessibility findings: 1 in card--default (image-alt)');
  });

  it('keys the story by mode, the way the accepted file does', () => {
    const failure = a11yFailureOf([violation()], {}, 'card--default', 'dark');
    assert.equal(failure, 'New accessibility findings: 2 in card--default@dark (image-alt)');
  });

  it('passes a capture whose every finding is accepted', () => {
    const every: AcceptedAccessibility = { 'card--default': { 'image-alt': ['img.hero', 'img.logo'] } };
    assert.equal(a11yFailureOf([violation()], every, 'card--default'), undefined);
  });
});

describe('readAcceptedA11y', () => {
  it('reads an empty set from a file that does not exist', async () => {
    assert.deepEqual(await readAcceptedA11y(path.join(await scratch(), 'accessibility.json')), {});
  });

  it('refuses a file that exists but is not the shape, rather than reading it as empty', async () => {
    const file = path.join(await scratch(), 'accessibility.json');
    await writeFile(file, 'not json', 'utf8');
    let thrown: Error | undefined;
    try {
      await readAcceptedA11y(file);
    } catch (error) {
      thrown = error as Error;
    }
    assert.match(thrown?.message ?? '', /accessibility\.json is not valid JSON/);
  });
});

describe('formatAcceptedA11y', () => {
  it('sorts at every level, so the file diffs only when the findings change', () => {
    const formatted = formatAcceptedA11y({
      'b--two': { 'button-name': ['button.b', 'button.a'] },
      'a--one@dark': { 'image-alt': ['img.x'] },
    });
    assert.equal(
      formatted,
      '{\n  "a--one@dark": {\n    "image-alt": [\n      "img.x"\n    ]\n  },\n' +
        '  "b--two": {\n    "button-name": [\n      "button.a",\n      "button.b"\n    ]\n  }\n}\n',
    );
  });
});

describe('adoptFindings', () => {
  const audit = (storyId: string, mode: string | undefined, rules?: Record<string, string[]>) => ({
    storyId,
    ...(mode !== undefined ? { mode } : {}),
    ...(rules !== undefined
      ? {
          accessibility: {
            violations: Object.entries(rules).map(([id, targets]) => ({
              id,
              impact: 'serious',
              help: id,
              helpUrl: `https://example.com/${id}`,
              targets: targets.map((target) => ({ target })),
            })),
          },
        }
      : {}),
  });

  const always = () => true;

  it('adopts exactly the current findings for the audited stories', () => {
    const existing: AcceptedAccessibility = { 'a--one': { 'image-alt': ['img.gone'] } };
    const adopted = adoptFindings(existing, [audit('a--one', undefined, { 'button-name': ['button.x'] })], always);
    assert.deepEqual(adopted?.next, { 'a--one': { 'button-name': ['button.x'] } });
  });

  it('drops a story that came back clean, so the file never grows stale', () => {
    const existing: AcceptedAccessibility = { 'a--one': { 'image-alt': ['img.gone'] } };
    const adopted = adoptFindings(existing, [audit('a--one', undefined, {})], always);
    assert.deepEqual(adopted?.next, {});
  });

  it('keeps the keys of stories outside the scope, and of ones the run never audited', () => {
    const existing: AcceptedAccessibility = {
      'a--one': { 'image-alt': ['img.old'] },
      'b--two': { 'button-name': ['button.old'] },
    };
    const forA = (storyId: string) => storyId === 'a--one';
    const adopted = adoptFindings(existing, [audit('a--one', undefined, { 'image-alt': ['img.new'] })], forA);
    assert.deepEqual(adopted?.next, {
      'a--one': { 'image-alt': ['img.new'] },
      'b--two': { 'button-name': ['button.old'] },
    });
    // a--one scoped but never audited by this run: its entry stands as it was, while the
    // audited story beside it is rewritten. (A run that audited nothing in scope returns
    // undefined and the caller never writes — the case the last test covers.)
    const both = (storyId: string) => storyId === 'a--one' || storyId === 'b--two';
    const untouched = adoptFindings(
      existing,
      [{ storyId: 'a--one' }, audit('b--two', undefined, { 'button-name': ['button.b'] })],
      both,
    );
    assert.deepEqual(untouched?.next, {
      'a--one': { 'image-alt': ['img.old'] },
      'b--two': { 'button-name': ['button.b'] },
    });
  });

  it('writes one key per mode, beside the base one', () => {
    const adopted = adoptFindings(
      {},
      [audit('a--one', undefined, { 'image-alt': ['img.a'] }), audit('a--one', 'dark', { 'button-name': ['button.b'] })],
      always,
    );
    assert.deepEqual(adopted?.next, {
      'a--one': { 'image-alt': ['img.a'] },
      'a--one@dark': { 'button-name': ['button.b'] },
    });
  });

  it('returns nothing when no scoped story was audited — the file stays as it is', () => {
    assert.equal(adoptFindings({}, [{ storyId: 'a--one' }], always), undefined);
    assert.equal(adoptFindings({}, [], always), undefined);
  });
});

/*
 * The accept side, driven like accept.test.ts drives it: a project directory with a
 * summary, run through the real command.
 */
function capture(over: Partial<CaptureResult>): CaptureResult {
  return {
    storyId: 'a--one',
    storyTitle: 'A',
    storyName: 'One',
    width: 320,
    status: 'unchanged',
    snapshotPath: 'a--one/320w-linux-x64.png',
    artifacts: {},
    ...over,
  };
}

const marked = (rules: Record<string, string[]>): { violations: MarkedA11yViolation[]; new: number } => ({
  violations: Object.entries(rules).map(([id, targets]) => ({
    id,
    impact: 'serious',
    help: id,
    helpUrl: `https://example.com/${id}`,
    targets: targets.map((target) => ({ target, new: true })),
  })),
  new: Object.values(rules).reduce((n, targets) => n + targets.length, 0),
});

function summaryOf(captures: CaptureResult[]): RunSummary {
  return {
    diopsis: 1,
    createdAt: '2026-01-01T00:00:00Z',
    platform: 'linux',
    arch: 'x64',
    mode: 'run',
    snapshotDir: '__screenshots__',
    totals: {
      stories: 0,
      captures: captures.length,
      unchanged: 0,
      unstable: 0,
      changed: 0,
      new: 0,
      removed: 0,
      renderFailed: 0,
      failed: 0,
      notRun: 0,
    },
    changedStories: [],
    captures,
  };
}

async function project(captures: CaptureResult[], accepted?: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-a11y-accept-'));
  temporaries.push(dir);
  await mkdir(path.join(dir, '.diopsis'), { recursive: true });
  await writeFile(path.join(dir, '.diopsis', 'summary.json'), JSON.stringify(summaryOf(captures)));
  if (accepted !== undefined) {
    await mkdir(path.join(dir, '__screenshots__'), { recursive: true });
    await writeFile(path.join(dir, '__screenshots__', 'accessibility.json'), accepted, 'utf8');
  }
  return dir;
}

async function runAccept(
  root: string,
  storyIds?: string[],
): Promise<{ code: number; out: string }> {
  const stdout: string[] = [];
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof writeOut;
  process.stderr.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof writeErr;
  try {
    const code = await acceptCommand({ root, ...(storyIds ? { storyIds } : {}), noStage: true });
    return { code, out: stdout.join('') };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

const acceptedFile = (root: string): string =>
  path.join(root, '__screenshots__', 'accessibility.json');

describe('acceptCommand with accessibility findings', () => {
  it('adopts current findings for the accepted stories, and drops what disappeared', async () => {
    const root = await project(
      [capture({ accessibility: marked({ 'image-alt': ['img.new'], 'button-name': ['button.x'] }) })],
      '{\n  "a--one": {\n    "image-alt": [\n      "img.gone"\n    ]\n  }\n}\n',
    );
    const { code, out } = await runAccept(root);
    assert.equal(code, 0);
    assert.match(out, /Accepted accessibility findings for 1 story/);
    assert.deepEqual(JSON.parse(await readFile(acceptedFile(root), 'utf8')), {
      'a--one': { 'image-alt': ['img.new'], 'button-name': ['button.x'] },
    });
  });

  it('adopts only the named stories, leaving the others’ entries untouched', async () => {
    const root = await project(
      [
        capture({ accessibility: marked({ 'image-alt': ['img.a'] }) }),
        capture({ storyId: 'b--two', snapshotPath: 'b--two/320w-linux-x64.png', accessibility: marked({ 'button-name': ['button.b'] }) }),
      ],
      '{\n  "b--two": {\n    "button-name": [\n      "button.old"\n    ]\n  }\n}\n',
    );
    const { code } = await runAccept(root, ['a--one']);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(await readFile(acceptedFile(root), 'utf8')), {
      'a--one': { 'image-alt': ['img.a'] },
      'b--two': { 'button-name': ['button.old'] },
    });
  });

  it('accepts a story that failed on findings alone — no image exists, none is needed', async () => {
    // 'fail' mode: the comparison passed, the audit failed the capture. There is no
    // artifact to copy and no skip to report — the findings are what is being accepted.
    const root = await project([
      capture({ status: 'changed', error: 'New accessibility findings: 1 in a--one (image-alt)', accessibility: marked({ 'image-alt': ['img.a'] }) }),
    ]);
    const { code, out } = await runAccept(root);
    assert.equal(code, 0);
    assert.doesNotMatch(out, /skipped/);
    assert.doesNotMatch(out, /Nothing to accept/);
    assert.ok(existsSync(acceptedFile(root)));
  });

  it('leaves the file alone when the run never audited', async () => {
    const root = await project(
      [capture({ status: 'changed', artifacts: { actual: 'test-results/a--one-320-actual.png' } })],
      '{\n  "a--one": {\n    "image-alt": [\n      "img.old"\n    ]\n  }\n}\n',
    );
    await mkdir(path.join(root, '.diopsis', 'test-results'), { recursive: true });
    await writeFile(path.join(root, '.diopsis', 'test-results', 'a--one-320-actual.png'), 'png');
    const { code, out } = await runAccept(root);
    assert.equal(code, 0);
    assert.doesNotMatch(out, /accessibility findings/);
    assert.equal(
      await readFile(acceptedFile(root), 'utf8'),
      '{\n  "a--one": {\n    "image-alt": [\n      "img.old"\n    ]\n  }\n}\n',
    );
  });

  it('drops findings the run no longer reports, and says so', async () => {
    // The story fixed its violations: pixels unchanged, audit clean. The accept's only
    // change to the file is the removal of a stale claim.
    const root = await project(
      [capture({ accessibility: { violations: [], new: 0 } })],
      formatAcceptedA11y({ 'a--one': { 'image-alt': ['img.gone'] } }),
    );
    const { code, out } = await runAccept(root);
    assert.equal(code, 0);
    assert.match(out, /Dropped accepted accessibility findings the run no longer reports/);
    assert.deepEqual(JSON.parse(await readFile(acceptedFile(root), 'utf8')), {});
  });

  it('does not rewrite a file whose adoption changes nothing', async () => {
    const existing = formatAcceptedA11y({ 'a--one': { 'image-alt': ['img.a'] } });
    // The run's findings are exactly what the file already holds — and marked as accepted,
    // the way the reporter would have marked them against that very file.
    const root = await project(
      [
        capture({
          accessibility: {
            violations: [
              {
                id: 'image-alt',
                impact: 'serious',
                help: 'image-alt',
                helpUrl: 'https://example.com/image-alt',
                targets: [{ target: 'img.a' }],
              },
            ],
            new: 0,
          },
        }),
      ],
      existing,
    );
    const { out } = await runAccept(root);
    // The findings were already accepted, so the accept says so by touching nothing.
    assert.doesNotMatch(out, /accessibility findings/);
    assert.equal(await readFile(acceptedFile(root), 'utf8'), existing);
  });
});
