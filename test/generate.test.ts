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

  it('names the state in braces after the mode, keeping titles unique', () => {
    const tagged: StoryEntry[] = [
      { id: 'a--one', name: 'One', title: 'A', tags: ['diopsis:hover=button', 'diopsis:modes=dark'] },
    ];
    const config = resolveConfig({
      viewports: { default: [320] },
      modes: { dark: { theme: 'dark' } },
    });
    const { captures } = resolveMatrix(tagged, config, 'linux-x64');
    const planned = planCaptures(captures, '/repo/__screenshots__');
    assert.deepEqual(
      planned.map((capture) => capture.title),
      ['a--one @320', 'a--one @320 {hover}', 'a--one @320 [dark]', 'a--one @320 [dark] {hover}'],
    );
    assert.equal(new Set(planned.map((capture) => capture.title)).size, planned.length);
    // The plan carries the whole state, so the spec applies it without reading a config.
    assert.deepEqual(planned[1]?.state, { name: 'hover', action: 'hover', selector: 'button' });
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

  it('applies a capture\'s interaction state and releases it after the assertion', async () => {
    const root = await scratch();
    const config = resolveConfig();
    const tagged: StoryEntry[] = [
      { id: 'a--one', name: 'One', title: 'A', tags: ['diopsis:active=button'] },
    ];
    const { captures } = resolveMatrix(tagged, config, 'linux-x64');
    const project = await generateProject({ root, config, captures, baseUrl: 'http://x' });

    const spec = await readFile(path.join(project.dir, 'diopsis.spec.js'), 'utf8');
    // The state goes on before the comparison and comes off in a finally, whatever the
    // comparison said — the page is reused, and the next capture must not inherit it.
    assert.match(spec, /if \(capture\.state\) await applyState\(page, capture\.state\);/);
    assert.match(spec, /} finally \{\s*\n\s*if \(capture\.state\) await releaseState\(page\);/);
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

describe('generateProject per-story tolerance', () => {
  it('resolves story overrides into the plan, replacing the configured count limits', async () => {
    const root = await scratch();
    const config = resolveConfig({ compare: { maxDiffPixels: 40 } });
    const tagged: StoryEntry[] = [
      {
        id: 'a--one',
        name: 'One',
        title: 'A',
        tags: ['diopsis:threshold=0.4', 'diopsis:max-diff-pixels=200'],
      },
    ];
    const { captures } = resolveMatrix(tagged, config, 'linux-x64');
    const project = await generateProject({ root, config, captures, baseUrl: 'http://x' });

    const plan = JSON.parse(await readFile(project.planPath, 'utf8')) as {
      compare: { maxDiffPixels?: number };
      captures: Array<{ compare?: Record<string, number> }>;
    };
    assert.equal(plan.compare.maxDiffPixels, 40);
    assert.deepEqual(plan.captures[0]?.compare, { threshold: 0.4, maxDiffPixels: 200 });

    const spec = await readFile(path.join(project.dir, 'diopsis.spec.js'), 'utf8');
    assert.match(spec, /capture\.compare \?\? plan\.compare/);
    assert.match(spec, /maxDiffPixels: compare\.maxDiffPixels/);
  });

  it('leaves an unset pixel count out of the options rather than tolerating zero', async () => {
    const root = await scratch();
    const config = resolveConfig();
    const { captures } = resolveMatrix(stories, config, 'linux-x64');
    const project = await generateProject({ root, config, captures, baseUrl: 'http://x' });

    const plan = JSON.parse(await readFile(project.planPath, 'utf8')) as {
      compare: Record<string, unknown>;
      captures: Array<{ compare?: Record<string, number> }>;
    };
    assert.equal('maxDiffPixels' in plan.compare, false);
    assert.equal(plan.captures.every((capture) => capture.compare === undefined), true);
    const spec = await readFile(path.join(project.dir, 'diopsis.spec.js'), 'utf8');
    assert.match(spec, /compare\.maxDiffPixels === undefined/);
  });
});

describe('generateProject component scope', () => {
  it('clips component captures and records the fallback when there is nothing to clip', async () => {
    const root = await scratch();
    const config = resolveConfig({ capture: 'component', viewports: { default: [320] } });
    const scoped: StoryEntry[] = [
      { id: 'a--chip', name: 'Chip', title: 'A', tags: ['diopsis:component'] },
      { id: 'b--page', name: 'Page', title: 'B', tags: ['diopsis:page'] },
    ];
    const { captures } = resolveMatrix(scoped, config, 'linux-x64');
    const project = await generateProject({ root, config, captures, baseUrl: 'http://x' });

    const plan = JSON.parse(await readFile(project.planPath, 'utf8')) as {
      captures: Array<{ scope: string }>;
    };
    assert.deepEqual(plan.captures.map((capture) => capture.scope), ['component', 'page']);

    const spec = await readFile(path.join(project.dir, 'diopsis.spec.js'), 'utf8');
    assert.match(spec, /capture\.scope === 'component'/);
    assert.match(spec, /componentClip\(page\)/);
    assert.match(spec, /fullPage: clip \? true : plan\.fullPage/);
    assert.match(spec, /type: 'diopsis-scope'/);
    assert.match(spec, /'fell back to page'/);
  });
});

describe('planCaptures baseline paths', () => {
  it('carries the absolute baseline path the spec checks before comparing', () => {
    const { captures } = resolveMatrix(stories, resolveConfig(), 'linux-x64');
    const root = path.resolve('/repo/__screenshots__');
    const planned = planCaptures(captures, root);
    assert.equal(planned[0]?.baselinePath, path.join(root, 'a--one', '320w-linux-x64.png'));
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

describe('generateProject retries', () => {
  const configOf = (retries: number) => resolveConfig({ stabilize: { retries } });

  it('runs with the configured retries', async () => {
    const root = await scratch();
    const config = configOf(3);
    const { captures } = resolveMatrix(stories, config, 'linux-x64');
    const project = await generateProject({ root, config, captures, baseUrl: 'http://x' });
    const configSource = await readFile(project.configPath, 'utf8');
    assert.match(configSource, /retries: 3,/);
  });

  it('defaults to one retry in run mode', async () => {
    const root = await scratch();
    const config = resolveConfig();
    const { captures } = resolveMatrix(stories, config, 'linux-x64');
    const project = await generateProject({ root, config, captures, baseUrl: 'http://x' });
    const configSource = await readFile(project.configPath, 'utf8');
    assert.match(configSource, /retries: 1,/);
  });

  it('regenerates baselines with retries off, whatever the config says', async () => {
    const root = await scratch();
    const config = configOf(3);
    const { captures } = resolveMatrix(stories, config, 'linux-x64');
    const project = await generateProject({ root, config, captures, baseUrl: 'http://x', mode: 'update' });
    const configSource = await readFile(project.configPath, 'utf8');
    // A retry would compare against the baseline the first attempt just wrote and pass.
    assert.match(configSource, /retries: 0,/);
    assert.doesNotMatch(configSource, /retries: 3/);
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

describe('planCaptures with modes', () => {
  const modes = { dark: { theme: 'dark' }, rtl: { direction: 'rtl' } };

  function plannedFor(tags: string[]) {
    const config = resolveConfig({ viewports: { default: [320] }, modes });
    const { captures } = resolveMatrix(
      [{ id: 'a--one', name: 'One', title: 'A', tags }],
      config,
      'linux-x64',
    );
    return planCaptures(captures, '/repo/__screenshots__', undefined, modes);
  }

  it('keeps titles unique by naming the mode in brackets', () => {
    const planned = plannedFor([]);
    assert.deepEqual(planned.map((c) => c.title), [
      'a--one @320',
      'a--one @320 [dark]',
      'a--one @320 [rtl]',
    ]);
    assert.equal(new Set(planned.map((c) => c.title)).size, planned.length);
  });

  it('resolves each mode into the globals the spec will pass, once, at planning time', () => {
    const planned = plannedFor([]);
    assert.deepEqual(planned.map((c) => c.globals), [undefined, { theme: 'dark' }, { direction: 'rtl' }]);
  });

  it('keeps the base capture free of globals', () => {
    const planned = plannedFor(['diopsis:modes=dark']);
    assert.equal(planned.length, 2);
    assert.equal('globals' in (planned[0] ?? {}), false);
    assert.deepEqual(planned[1]?.globals, { theme: 'dark' });
  });
});

describe('generateProject with modes', () => {
  it('writes the resolved globals into the plan and passes them from the spec', async () => {
    const root = await scratch();
    const modes = { dark: { theme: 'dark mode' } };
    const config = resolveConfig({ viewports: { default: [320] }, modes });
    const { captures } = resolveMatrix(
      [{ id: 'a--one', name: 'One', title: 'A', tags: [] }],
      config,
      'linux-x64',
    );
    const project = await generateProject({ root, config, captures, baseUrl: 'http://x' });

    const plan = JSON.parse(await readFile(project.planPath, 'utf8')) as {
      captures: Array<{ title: string; globals?: Record<string, string>; mode?: string }>;
    };
    assert.deepEqual(plan.captures.map((capture) => capture.title), [
      'a--one @320',
      'a--one @320 [dark]',
    ]);
    assert.equal(plan.captures[1]?.mode, 'dark');
    assert.deepEqual(plan.captures[1]?.globals, { theme: 'dark mode' });

    // The spec hands the plan's globals to the URL builder; it never reads the config.
    const spec = await readFile(path.join(project.dir, 'diopsis.spec.js'), 'utf8');
    assert.match(spec, /storyUrlFor\(plan\.baseUrl, capture\.storyId, capture\.globals\)/);
  });
});

describe('generateProject with the accessibility audit', () => {
  it('carries the mode, the library and the accepted-findings file in the plan', async () => {
    const root = await scratch();
    const config = resolveConfig({ accessibility: 'report' });
    const { captures } = resolveMatrix(stories, config, 'linux-x64');
    const project = await generateProject({
      root,
      config,
      captures,
      baseUrl: 'http://x',
      axePath: '/tested/node_modules/axe-core/axe.js',
    });

    const plan = JSON.parse(await readFile(project.planPath, 'utf8')) as {
      accessibility: string;
      axePath?: string;
      a11yAcceptedPath?: string;
    };
    assert.equal(plan.accessibility, 'report');
    assert.equal(plan.axePath, '/tested/node_modules/axe-core/axe.js');
    assert.equal(plan.a11yAcceptedPath, path.join(root, '__screenshots__', 'accessibility.json'));

    // The spec audits the marked capture, records the findings, and never decides anything
    // itself: the plan says whether a new finding fails the run.
    const spec = await readFile(path.join(project.dir, 'diopsis.spec.js'), 'utf8');
    assert.match(spec, /if \(capture\.a11y && plan\.accessibility !== 'off' && axeSource\)/);
    assert.match(spec, /type: 'diopsis-a11y'/);
    assert.match(spec, /if \(plan\.accessibility === 'fail'\)/);
  });

  it('plans nothing for an off run, and never fails an update', async () => {
    const root = await scratch();
    const { captures } = resolveMatrix(stories, resolveConfig(), 'linux-x64');

    const off = await generateProject({ root, config: resolveConfig(), captures, baseUrl: 'http://x' });
    const offPlan = JSON.parse(await readFile(off.planPath, 'utf8')) as { accessibility: string };
    assert.equal(offPlan.accessibility, 'off');
    assert.equal('axePath' in offPlan, false);

    // A regeneration writes baselines and passes by construction; failing it on findings
    // would be a 'fail' run nothing can be accepted from.
    const update = await generateProject({
      root,
      config: resolveConfig({ accessibility: 'fail' }),
      captures,
      baseUrl: 'http://x',
      mode: 'update',
    });
    const updatePlan = JSON.parse(await readFile(update.planPath, 'utf8')) as { accessibility: string };
    assert.equal(updatePlan.accessibility, 'report');
  });
});
