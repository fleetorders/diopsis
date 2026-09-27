import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { resolveConfig } from '../src/config.ts';
import { resolveMatrix } from '../src/matrix.ts';
import { generateProject, planCaptures, projectDir } from '../src/runner/generate.ts';
import type { StoryEntry } from '../src/story-index.ts';

const temporaries: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-gen-'));
  temporaries.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const stories: StoryEntry[] = [
  { id: 'a--one', name: 'One', title: 'A', tags: [] },
  { id: 'b--wide', name: 'Wide', title: 'B', tags: ['diopsis:1280'] },
];

describe('planCaptures', () => {
  it('gives every capture a unique Playwright test title', () => {
    const { captures } = resolveMatrix(stories, resolveConfig(), 'linux-x64');
    const titles = planCaptures(captures, '/repo/__screenshots__').map((c) => c.title);
    assert.equal(new Set(titles).size, titles.length);
    assert.deepEqual(titles, ['a--one @320', 'a--one @1280', 'b--wide @1280']);
  });

  it('splits the snapshot path into segments Playwright will rejoin', () => {
    const { captures } = resolveMatrix(stories, resolveConfig(), 'linux-x64');
    assert.deepEqual(planCaptures(captures, '/repo/__screenshots__')[0]?.segments, ['a--one', '320w-linux-x64.png']);
  });
});

describe('projectDir', () => {
  it('sits under the tested project so the peer Playwright resolves by ordinary lookup', () => {
    assert.equal(
      projectDir('/somewhere/app'),
      path.join('/somewhere/app', 'node_modules', '.diopsis', 'project'),
    );
  });
});

describe('generateProject', () => {
  it('writes a runnable Playwright project', async () => {
    const root = await scratch();
    const config = resolveConfig();
    const { captures } = resolveMatrix(stories, config, 'linux-x64');
    const project = await generateProject({
      root,
      config,
      captures,
      baseUrl: 'http://127.0.0.1:4321',
    });

    const configSource = await readFile(project.configPath, 'utf8');
    const plan = JSON.parse(await readFile(project.planPath, 'utf8')) as {
      captures: unknown[];
      baseUrl: string;
    };

    assert.equal(plan.captures.length, 3);
    assert.equal(plan.baseUrl, 'http://127.0.0.1:4321');
    assert.match(configSource, /chromium/);
    assert.match(configSource, /timezoneId: 'UTC'/);
  });

  it('points snapshots at an absolute path in the tested repo, not inside the temp project', async () => {
    const root = await scratch();
    const config = resolveConfig({ snapshotDir: '__screenshots__' });
    const { captures } = resolveMatrix(stories, config, 'linux-x64');
    const project = await generateProject({
      root,
      config,
      captures,
      baseUrl: 'http://127.0.0.1:4321',
    });

    const configSource = await readFile(project.configPath, 'utf8');
    const expected = JSON.stringify(path.join(root, '__screenshots__', '{arg}{ext}'));
    assert.ok(
      configSource.includes(`snapshotPathTemplate: ${expected}`),
      `template not found in:\n${configSource}`,
    );
  });

  it('cleans up after itself', async () => {
    const root = await scratch();
    const config = resolveConfig();
    const { captures } = resolveMatrix(stories, config, 'linux-x64');
    const project = await generateProject({ root, config, captures, baseUrl: 'http://x' });
    await project.cleanup();
    await assert.rejects(() => readFile(project.configPath, 'utf8'));
  });
});

describe('planCaptures baseline paths', () => {
  it('carries the absolute baseline path the spec checks before comparing', () => {
    const { captures } = resolveMatrix(stories, resolveConfig(), 'linux-x64');
    const planned = planCaptures(captures, '/repo/__screenshots__');
    assert.equal(planned[0]?.baselinePath, '/repo/__screenshots__/a--one/320w-linux-x64.png');
  });
});

describe('generateProject spec annotations', () => {
  it('records baseline existence as an annotation instead of trusting message wording', async () => {
    const root = await scratch();
    const config = resolveConfig();
    const { captures } = resolveMatrix(stories, config, 'linux-x64');
    const project = await generateProject({
      root,
      config,
      captures,
      baseUrl: 'http://127.0.0.1:4321',
    });

    const spec = await readFile(path.join(project.dir, 'diopsis.spec.js'), 'utf8');
    assert.match(spec, /existsSync\(capture\.baselinePath\)/);
    assert.match(spec, /type: 'diopsis-baseline'/);
  });

  it('writes the baseline path into the plan the spec reads', async () => {
    const root = await scratch();
    const config = resolveConfig();
    const { captures } = resolveMatrix(stories, config, 'linux-x64');
    const project = await generateProject({
      root,
      config,
      captures,
      baseUrl: 'http://127.0.0.1:4321',
    });

    const plan = JSON.parse(await readFile(project.planPath, 'utf8')) as {
      captures: { baselinePath: string }[];
    };
    assert.equal(
      plan.captures[0]?.baselinePath,
      path.join(root, '__screenshots__', 'a--one/320w-linux-x64.png'),
    );
  });
});

describe('generateProject workers', () => {
  it('quotes a percentage workers setting, so the generated config stays valid JavaScript', async () => {
    const root = await scratch();
    const config = resolveConfig({ workers: '50%' });
    const { captures } = resolveMatrix(stories, config, 'linux-x64');
    const project = await generateProject({ root, config, captures, baseUrl: 'http://x' });
    const configSource = await readFile(project.configPath, 'utf8');
    // Bare interpolation would emit `workers: 50%,` — a syntax error in the generated file.
    assert.match(configSource, /workers: "50%",/);
  });

  it('emits a numeric workers setting as a number', async () => {
    const root = await scratch();
    const config = resolveConfig({ workers: 4 });
    const { captures } = resolveMatrix(stories, config, 'linux-x64');
    const project = await generateProject({ root, config, captures, baseUrl: 'http://x' });
    const configSource = await readFile(project.configPath, 'utf8');
    assert.match(configSource, /workers: 4,/);
  });
});
