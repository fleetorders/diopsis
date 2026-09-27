import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  defaultConfig,
  findConfigFile,
  loadConfig,
  resolveConfig,
  supportsTypeStripping,
  type UserConfig,
} from '../src/config.ts';

const temporaries: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-test-'));
  temporaries.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveConfig', () => {
  it('merges stabilize and compare per key rather than wholesale', () => {
    const config = resolveConfig({ stabilize: { freezeClock: false } });
    assert.equal(config.stabilize.freezeClock, false);
    assert.equal(config.stabilize.waitForNetworkIdle, true);
    assert.equal(config.compare.maxDiffPixelRatio, defaultConfig.compare.maxDiffPixelRatio);
  });

  it('replaces viewports wholesale, since a merged matrix is never what was meant', () => {
    const config = resolveConfig({ viewports: { default: [768] } });
    assert.deepEqual(config.viewports, { default: [768] });
  });

  it('defaults every determinism guarantee on', () => {
    const { stabilize } = resolveConfig();
    assert.equal(stabilize.disableAnimations, true);
    assert.equal(stabilize.waitForFonts, true);
    assert.equal(stabilize.waitForImages, true);
    assert.equal(stabilize.waitForLoadingStates, true);
    assert.equal(typeof stabilize.freezeClock, 'string');
  });

  it('ships a non-zero pixel-ratio tolerance so one stray pixel cannot block a pipeline', () => {
    assert.ok(defaultConfig.compare.maxDiffPixelRatio > 0);
  });

  it('leaves the pixel-count tolerance off unless configured', () => {
    // Off, not zero: an unset maxDiffPixels must not silently tolerate exactly nothing.
    assert.equal(resolveConfig().compare.maxDiffPixels, undefined);
    assert.equal(resolveConfig({ compare: { maxDiffPixels: 250 } }).compare.maxDiffPixels, 250);
  });

  it('accepts compare.maxDiffPixels through the public UserConfig type', () => {
    // A compile-time guarantee dressed as a test: the literal stops typechecking the day
    // the key is dropped from the public type.
    const user: UserConfig = { compare: { maxDiffPixels: 250 } };
    assert.deepEqual(resolveConfig(user).compare, {
      ...defaultConfig.compare,
      maxDiffPixels: 250,
    });
  });

  it('recognises only its own ignore attribute', () => {
    assert.deepEqual(defaultConfig.mask, ['[data-diopsis-ignore]']);
  });

  it('captures the whole page unless the config says component', () => {
    assert.equal(resolveConfig().capture, 'page');
    assert.equal(resolveConfig({ capture: 'component' }).capture, 'component');
  });
});

describe('supportsTypeStripping', () => {
  it('is true from Node 22.18 and on every later major', () => {
    assert.equal(supportsTypeStripping('22.18.0'), true);
    assert.equal(supportsTypeStripping('22.22.3'), true);
    assert.equal(supportsTypeStripping('24.0.0'), true);
  });

  it('is false on runtimes that cannot read a TypeScript config', () => {
    assert.equal(supportsTypeStripping('22.17.9'), false);
    assert.equal(supportsTypeStripping('20.11.0'), false);
    assert.equal(supportsTypeStripping('18.0.0'), false);
  });
});

describe('findConfigFile', () => {
  it('prefers the TypeScript config when several exist', async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, 'diopsis.config.mjs'), 'export default {}');
    await writeFile(path.join(dir, 'diopsis.config.ts'), 'export default {}');
    assert.equal(findConfigFile(dir), path.join(dir, 'diopsis.config.ts'));
  });

  it('returns nothing when there is no config at all', async () => {
    assert.equal(findConfigFile(await scratch()), undefined);
  });
});

describe('loadConfig', () => {
  it('falls back to defaults with no config file present', async () => {
    const loaded = await loadConfig(await scratch());
    assert.equal(loaded.filepath, undefined);
    assert.equal(loaded.config.storybookDir, defaultConfig.storybookDir);
  });

  it('loads a JavaScript config', async () => {
    const dir = await scratch();
    await writeFile(
      path.join(dir, 'diopsis.config.mjs'),
      'export default { storybookDir: "out", viewports: { default: [640] } };',
    );
    const loaded = await loadConfig(dir);
    assert.equal(loaded.config.storybookDir, 'out');
    assert.deepEqual(loaded.config.viewports, { default: [640] });
  });

  it('loads a TypeScript config through Node type stripping', async (t) => {
    if (!supportsTypeStripping()) t.skip('runtime cannot strip types');
    const dir = await scratch();
    await writeFile(
      path.join(dir, 'diopsis.config.ts'),
      'const width: number = 640;\nexport default { viewports: { default: [width] } };\n',
    );
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.config.viewports, { default: [640] });
  });

  it('rejects a config that exports no object', async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, 'diopsis.config.mjs'), 'export default 42;');
    await assert.rejects(() => loadConfig(dir), /default export/);
  });
});

import { validateConfig, type DiopsisConfig } from '../src/config.ts';

describe('validateConfig', () => {
  function configWith(over: {
    viewports?: unknown;
    viewportHeight?: unknown;
    capture?: unknown;
    timeout?: unknown;
    workers?: unknown;
    fullPage?: unknown;
    mask?: unknown;
    affected?: unknown;
    stabilize?: Record<string, unknown>;
    compare?: Record<string, unknown>;
  }): DiopsisConfig {
    const base = resolveConfig();
    return {
      ...base,
      ...over,
      stabilize: { ...base.stabilize, ...over.stabilize },
      compare: { ...base.compare, ...over.compare },
    } as DiopsisConfig;
  }

  it('accepts an explicit empty default set — the "only tagged stories" choice', () => {
    assert.deepEqual(validateConfig(configWith({ viewports: { default: [], mobile: [320] } })), []);
  });

  it('demands a default set, so untagged stories cannot silently lose their widths', () => {
    const problems = validateConfig(configWith({ viewports: { mobile: [320] } }));
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /viewports must define a "default" set/);
  });

  it('names the key and the bad value of each viewport set', () => {
    const problems = validateConfig(configWith({ viewports: { default: [640], mobile: 640 } }));
    assert.equal(problems.length, 1);
    assert.match(
      problems[0] ?? '',
      /viewports\.mobile must be an array of positive integer widths \(got 640\)/,
    );
  });

  it('rejects zero and fractional widths', () => {
    const problems = validateConfig(configWith({ viewports: { default: [320, 0, 1.5] } }));
    assert.match(problems[0] ?? '', /got \[320,0,1\.5\]/);
  });

  it('checks every numeric knob', () => {
    const problems = validateConfig(
      configWith({ viewportHeight: 0, timeout: -1, stabilize: { settleTimeout: 0 } }),
    );
    assert.ok(problems.some((p) => /viewportHeight must be a positive integer \(got 0\)/.test(p)));
    assert.ok(problems.some((p) => /timeout must be a positive number \(got -1\)/.test(p)));
    assert.ok(
      problems.some((p) => /stabilize\.settleTimeout must be a positive number \(got 0\)/.test(p)),
    );
  });

  it('bounds the pixel-count tolerance to non-negative integers', () => {
    assert.deepEqual(validateConfig(configWith({ compare: { maxDiffPixels: 0 } })), []);
    const problems = validateConfig(configWith({ compare: { maxDiffPixels: -1 } }));
    assert.equal(problems.length, 1);
    assert.match(
      problems[0] ?? '',
      /compare\.maxDiffPixels must be a non-negative integer \(got -1\)/,
    );
    assert.match(
      validateConfig(configWith({ compare: { maxDiffPixels: 1.5 } }))[0] ?? '',
      /got 1\.5/,
    );
    assert.match(
      validateConfig(configWith({ compare: { maxDiffPixels: 'many' } }))[0] ?? '',
      /got "many"/,
    );
  });

  it('bounds both comparators to the unit interval', () => {
    const problems = validateConfig(configWith({ compare: { threshold: 2, maxDiffPixelRatio: 'x' } }));
    assert.ok(
      problems.some((p) => /compare\.threshold must be a number between 0 and 1 \(got 2\)/.test(p)),
    );
    assert.ok(
      problems.some((p) => /compare\.maxDiffPixelRatio must be a number between 0 and 1 \(got "x"\)/.test(p)),
    );
  });

  it('accepts workers as a count or a percentage, and nothing else', () => {
    assert.deepEqual(validateConfig(configWith({ workers: 4 })), []);
    assert.deepEqual(validateConfig(configWith({ workers: '50%' })), []);
    const problems = validateConfig(configWith({ workers: 'all' }));
    assert.match(
      problems[0] ?? '',
      /workers must be a positive integer or a percentage like "50%" \(got "all"\)/,
    );
  });

  it('accepts "page" and "component" as the capture scope, and nothing else', () => {
    assert.deepEqual(validateConfig(configWith({ capture: 'page' })), []);
    assert.deepEqual(validateConfig(configWith({ capture: 'component' })), []);
    const problems = validateConfig(configWith({ capture: 'story' }));
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /capture must be "page" or "component" \(got "story"\)/);
  });

  it('checks the remaining shape rules', () => {
    const problems = validateConfig(
      configWith({
        fullPage: 'yes',
        mask: '[data-x]',
        affected: 'everything',
        stabilize: { freezeClock: 'not-a-date' },
      }),
    );
    assert.ok(problems.some((p) => /fullPage must be true or false/.test(p)));
    assert.ok(problems.some((p) => /mask must be an array of selector strings/.test(p)));
    assert.ok(problems.some((p) => /affected must be "all" or "auto"/.test(p)));
    assert.ok(problems.some((p) => /stabilize\.freezeClock must be false or a date/.test(p)));
  });

  it('accepts freezeClock false and a date Date can parse', () => {
    assert.deepEqual(validateConfig(configWith({ stabilize: { freezeClock: false } })), []);
    assert.deepEqual(
      validateConfig(configWith({ stabilize: { freezeClock: '2026-01-15T12:00:00Z' } })),
      [],
    );
  });
});

describe('loadConfig validation', () => {
  it('throws one error, prefixed with the file name, listing every problem', async () => {
    const dir = await scratch();
    await writeFile(
      path.join(dir, 'diopsis.config.mjs'),
      'export default { viewportHeight: 0, timeout: -1 };',
    );
    await assert.rejects(
      () => loadConfig(dir),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        assert.match(message, /^diopsis\.config\.mjs has 2 problems:\n/);
        assert.match(message, /\n  - viewportHeight must be a positive integer/);
        assert.match(message, /\n  - timeout must be a positive number/);
        return true;
      },
    );
  });

  it('rejects viewports that leave untagged stories with nothing', async () => {
    const dir = await scratch();
    await writeFile(
      path.join(dir, 'diopsis.config.mjs'),
      'export default { viewports: { mobile: [320] } };',
    );
    await assert.rejects(
      () => loadConfig(dir),
      /diopsis\.config\.mjs: viewports must define a "default" set/,
    );
  });

  it('wraps a config that throws while loading', async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, 'diopsis.config.mjs'), 'throw new Error("boom");');
    await assert.rejects(() => loadConfig(dir), /Could not load diopsis\.config\.mjs: boom/);
  });

  it('hints at the module format when a .js config cannot be loaded', async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, 'diopsis.config.js'), 'throw new Error("nope");');
    await assert.rejects(
      () => loadConfig(dir),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        assert.match(message, /Could not load diopsis\.config\.js: nope/);
        assert.match(message, /"type": "module".*\.mjs extension/);
        return true;
      },
    );
  });
});
