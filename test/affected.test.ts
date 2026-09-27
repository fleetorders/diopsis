import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normaliseModuleName,
  resolveAffected,
  traceFile,
  type AffectedResult,
  type AffectedStory,
  type PreviewStats,
  type TraceOutcome,
} from '../src/affected.ts';

/** The reason a full run was forced, with the kind asserted rather than trusted. */
function fullReason(out: AffectedResult | TraceOutcome): string {
  if (out.kind !== 'full') throw new Error(`expected a full run, got "${out.kind}"`);
  return out.reason;
}

const story = (id: string, importPath?: string): AffectedStory => ({
  id,
  ...(importPath ? { importPath } : {}),
});

const STORIES: AffectedStory[] = [
  story('example-button--primary', './src/Button.stories.tsx'),
  story('example-button--secondary', './src/Button.stories.tsx'),
  story('example-input--filled', './src/Input.stories.tsx'),
];

/** A Vite-shaped stats file: one module per file, names already `./`-relative. */
const VITE: PreviewStats = {
  modules: [
    { name: './src/Button.tsx', reasons: [{ moduleName: './src/Button.stories.tsx' }] },
    { name: './src/Button.stories.tsx', reasons: [{ moduleName: '/virtual:/@storybook/builder-vite/vite-app.js' }] },
    { name: './src/Input.tsx', reasons: [{ moduleName: './src/Input.stories.tsx' }] },
    { name: './src/Input.stories.tsx', reasons: [{ moduleName: '/virtual:/@storybook/builder-vite/vite-app.js' }] },
    { name: './src/lib/deep.ts', reasons: [{ moduleName: './src/lib/mid.ts' }] },
    { name: './src/lib/mid.ts', reasons: [{ moduleName: './src/Button.tsx' }] },
    { name: './src/tokens.ts', reasons: [
      { moduleName: './src/Button.stories.tsx' },
      { moduleName: './src/Input.stories.tsx' },
    ] },
    { name: './src/unused.ts', reasons: [] },
  ],
};

const affectedSince = (changed: string[], over: Partial<Parameters<typeof resolveAffected>[0]> = {}) =>
  resolveAffected({ changed, stories: STORIES, stats: VITE, ...over });

describe('normaliseModuleName', () => {
  it('strips the concatenated-module suffix webpack appends', () => {
    assert.equal(normaliseModuleName('./src/Pin.tsx + 3 modules').path, 'src/Pin.tsx');
    assert.equal(normaliseModuleName('./src/Pin.tsx + 12 modules').path, 'src/Pin.tsx');
  });

  it('strips query parameters', () => {
    assert.equal(normaliseModuleName('./src/README.css?raw').path, 'src/README.css');
  });

  it('accepts Windows separators', () => {
    assert.equal(normaliseModuleName('.\\src\\Button.tsx').path, 'src/Button.tsx');
  });

  it('joins the project directory for monorepos', () => {
    assert.equal(
      normaliseModuleName('./src/Button.tsx', 'packages/ui/').path,
      'packages/ui/src/Button.tsx',
    );
  });

  it('never treats a virtual or internal module as a file path', () => {
    for (const name of ['/virtual:/@storybook/builder-vite/vite-app.js', 'virtual:jsonstories--data', '(webpack)/runtime/define']) {
      const out = normaliseModuleName(name);
      assert.equal(out.virtual, true, name);
    }
    assert.equal(normaliseModuleName('./src/Button.tsx').virtual, false);
  });
});

describe('resolveAffected', () => {
  it('marks the stories of a changed story file itself (tier 1)', () => {
    const out = affectedSince(['src/Button.stories.tsx']);
    assert.equal(out.kind, 'set');
    assert.deepEqual(out.kind === 'set' && out.storyIds, [
      'example-button--primary',
      'example-button--secondary',
    ]);
    assert.deepEqual(out.kind === 'set' && out.traces['example-button--primary'], [
      'src/Button.stories.tsx',
    ]);
  });

  it('follows the importers of a changed component', () => {
    const out = affectedSince(['src/Button.tsx']);
    assert.deepEqual(out.kind === 'set' && out.storyIds, [
      'example-button--primary',
      'example-button--secondary',
    ]);
    assert.deepEqual(out.kind === 'set' && out.traces['example-button--secondary'], [
      'src/Button.tsx',
      'src/Button.stories.tsx',
    ]);
  });

  it('walks chains as deep as the graph has them', () => {
    const out = affectedSince(['src/lib/deep.ts']);
    assert.deepEqual(out.kind === 'set' && out.storyIds, [
      'example-button--primary',
      'example-button--secondary',
    ]);
    assert.deepEqual(out.kind === 'set' && out.traces['example-button--primary'], [
      'src/lib/deep.ts',
      'src/lib/mid.ts',
      'src/Button.tsx',
      'src/Button.stories.tsx',
    ]);
  });

  it('reaches only the stories a change touches', () => {
    const out = affectedSince(['src/Input.tsx']);
    assert.deepEqual(out.kind === 'set' && out.storyIds, ['example-input--filled']);
  });

  it('returns an empty set when a graphed change reaches no story', () => {
    const out = affectedSince(['src/unused.ts']);
    assert.deepEqual(out.kind === 'set' && out.storyIds, []);
    assert.deepEqual(out.kind === 'set' && out.traces, {});
  });

  it('walks a webpack-shaped graph through a concatenated module', () => {
    const webpack: PreviewStats = {
      modules: [
        {
          id: 0,
          name: './src/Pin.tsx + 3 modules',
          modules: [
            { name: './src/Pin.tsx' },
            { name: './src/lib/pin-a.ts' },
            { name: './src/lib/pin-b.ts' },
          ],
          reasons: [{ moduleName: './src/Pin.stories.tsx' }],
        },
        { id: 1, name: './src/Pin.stories.tsx', reasons: [{ moduleName: './entry.js' }] },
      ],
    };
    const stories = [story('pin--default', './src/Pin.stories.tsx')];

    // A folded member: reached through the folded entry's own importers.
    const member = resolveAffected({ changed: ['src/lib/pin-a.ts'], stories, stats: webpack });
    assert.deepEqual(member.kind === 'set' && member.storyIds, ['pin--default']);
    assert.deepEqual(member.kind === 'set' && member.traces['pin--default'], [
      'src/lib/pin-a.ts',
      'src/Pin.stories.tsx',
    ]);

    // The folded entry itself, named with or without its suffix.
    for (const changed of ['src/Pin.tsx', 'src/Pin.tsx + 3 modules']) {
      const out = resolveAffected({ changed: [changed], stories, stats: webpack });
      assert.deepEqual(out.kind === 'set' && out.storyIds, ['pin--default'], changed);
    }
  });

  it('joins a monorepo project directory into graph names', () => {
    const stats: PreviewStats = {
      modules: [
        { name: './src/Button.tsx', reasons: [{ moduleName: './src/Button.stories.tsx' }] },
        { name: './src/Button.stories.tsx', reasons: [] },
      ],
    };
    const stories = [story('example-button--primary', './src/Button.stories.tsx')];
    const out = resolveAffected({
      changed: ['packages/ui/src/Button.tsx'],
      stories,
      stats,
      projectDir: 'packages/ui',
    });
    assert.deepEqual(out.kind === 'set' && out.storyIds, ['example-button--primary']);

    // The same file named without the project prefix is nothing the graph knows — the
    // monorepo mismatch collapses into a full run, never a wrong skip.
    const mismatched = resolveAffected({
      changed: ['src/Button.tsx'],
      stories,
      stats,
      projectDir: 'packages/ui',
    });
    assert.match(fullReason(mismatched), /not in the module graph/);
  });

  it('captures stories with virtual import paths whatever changed', () => {
    const stories = [
      ...STORIES,
      story('data--json', 'virtual:jsonstories--data'),
      story('legacy--none'),
    ];
    const out = resolveAffected({ changed: ['src/Button.tsx'], stories, stats: VITE });
    assert.deepEqual(out.kind === 'set' && out.storyIds, [
      'data--json',
      'example-button--primary',
      'example-button--secondary',
      'legacy--none',
    ]);
    // No trace exists for a story no graph can place — only the guarantee it was captured.
    assert.equal(out.kind === 'set' && out.traces['data--json'], undefined);

    const nothing = resolveAffected({ changed: [], stories, stats: VITE });
    assert.deepEqual(nothing.kind === 'set' && nothing.storyIds, ['data--json', 'legacy--none']);
  });

  it('terminates on circular reasons', () => {
    const cyclic: PreviewStats = {
      modules: [
        { name: './src/a.ts', reasons: [{ moduleName: './src/b.ts' }] },
        { name: './src/b.ts', reasons: [{ moduleName: './src/a.ts' }, { moduleName: './src/C.stories.tsx' }] },
        { name: './src/C.stories.tsx', reasons: [] },
      ],
    };
    const stories = [story('c--one', './src/C.stories.tsx')];
    const out = resolveAffected({ changed: ['src/a.ts'], stories, stats: cyclic });
    assert.deepEqual(out.kind === 'set' && out.storyIds, ['c--one']);
  });

  it('drops ignored globs from the changed set before classifying', () => {
    const out = affectedSince(['docs/guide.md', 'README.md', 'src/Button.tsx'], {
      options: { ignore: ['docs/**', '*.md'] },
    });
    assert.equal(out.kind, 'set');
    assert.deepEqual(out.kind === 'set' && out.storyIds, [
      'example-button--primary',
      'example-button--secondary',
    ]);
  });
});

describe('resolveAffected full runs', () => {
  const full = (changed: string[], over: Partial<Parameters<typeof resolveAffected>[0]> = {}) => {
    const out = affectedSince(changed, over);
    assert.equal(out.kind, 'full', `${changed.join(', ')} should force a full run`);
    return out.kind === 'full' ? out.reason : '';
  };

  it('forces a full run for the Storybook config directory', () => {
    for (const file of ['.storybook/main.ts', '.storybook/preview.ts', '.storybook/theme.js']) {
      assert.match(full([file]), /Storybook config directory/);
    }
  });

  it('forces a full run for the Diopsis config', () => {
    assert.match(full(['diopsis.config.mjs']), /Diopsis config/);
    assert.match(full(['diopsis.config.ts']), /Diopsis config/);
  });

  it('forces a full run for package manifests and lockfiles', () => {
    for (const file of [
      'package.json',
      'packages/ui/package.json',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
    ]) {
      assert.match(full([file]), /package manifest or lockfile/);
    }
  });

  it('forces a full run for builder and post-processor configurations', () => {
    for (const file of [
      'vite.config.ts',
      'vite.config.mjs',
      'webpack.config.js',
      'postcss.config.cjs',
      'tailwind.config.js',
    ]) {
      assert.match(full([file]), /build configuration/);
    }
  });

  it('forces a full run for files inside static directories', () => {
    assert.match(full(['assets/fonts/body.woff2'], { options: { staticDirs: ['assets'] } }), /static directory/);
  });

  it('forces a full run when the build wrote no stats file', () => {
    const out = resolveAffected({ changed: ['src/Button.tsx'], stories: STORIES });
    assert.equal(out.kind, 'full');
    assert.match(fullReason(out), /no preview-stats\.json/);
  });

  it('forces a full run when a story file is missing from the graph', () => {
    const out = resolveAffected({
      changed: ['src/Button.tsx'],
      stories: [...STORIES, story('ghost--one', './src/Ghost.stories.tsx')],
      stats: VITE,
    });
    assert.equal(out.kind, 'full');
    assert.match(fullReason(out), /src\/Ghost\.stories\.tsx \(ghost--one\) is missing/);
  });

  it('forces a full run for a changed file the graph does not know', () => {
    assert.match(full(['src/not-in-the-build.ts']), /not in the module graph/);
    assert.match(full(['README.md']), /not in the module graph/);
  });
});

describe('traceFile', () => {
  it('prints every chain from a file to the stories it reaches', () => {
    const out = traceFile({ file: 'src/tokens.ts', stories: STORIES, stats: VITE });
    assert.equal(out.kind, 'chains');
    if (out.kind !== 'chains') return;
    assert.deepEqual(out.chains.map(({ chain }) => chain.join('|')), [
      'src/tokens.ts|src/Button.stories.tsx',
      'src/tokens.ts|src/Input.stories.tsx',
    ]);
    assert.deepEqual(out.chains[0]?.storyIds, ['example-button--primary', 'example-button--secondary']);
    assert.deepEqual(out.chains[1]?.storyIds, ['example-input--filled']);
    assert.equal(out.more, false);
  });

  it('carries a deep chain end to end', () => {
    const out = traceFile({ file: 'src/lib/deep.ts', stories: STORIES, stats: VITE });
    assert.deepEqual(
      out.kind === 'chains' && out.chains[0]?.chain,
      ['src/lib/deep.ts', 'src/lib/mid.ts', 'src/Button.tsx', 'src/Button.stories.tsx'],
    );
  });

  it('says when no story reaches the file', () => {
    const out = traceFile({ file: 'src/unused.ts', stories: STORIES, stats: VITE });
    assert.equal(out.kind, 'none');
  });

  it('states the full-run reason a trigger would force', () => {
    const out = traceFile({ file: 'package.json', stories: STORIES, stats: VITE });
    assert.match(fullReason(out), /package manifest or lockfile/);
  });

  it('states the full-run reason an unknown file would force', () => {
    const out = traceFile({ file: 'src/nope.ts', stories: STORIES, stats: VITE });
    assert.match(fullReason(out), /not in the module graph/);
  });
});

describe('malformed stats input', () => {
  it('reads a non-array modules list as no graph, which is a full run', () => {
    const out = resolveAffected({
      changed: ['src/Button.tsx'],
      stories: STORIES,
      stats: JSON.parse('{"modules": 42}') as PreviewStats,
    });
    assert.match(fullReason(out), /is missing from the module graph/);
  });
});
