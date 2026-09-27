import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { displayPath } from '../src/paths.ts';

describe('displayPath', () => {
  it('prints forward slashes even where the platform separator is a backslash', () => {
    assert.equal(
      displayPath('C:\\repo', 'C:\\repo\\.diopsis\\report.html', path.win32),
      '.diopsis/report.html',
    );
  });

  it('falls back to the target itself when it is the base', () => {
    assert.equal(displayPath('/repo', '/repo'), '/repo');
  });
});

describe('printed and recorded paths', () => {
  it('go through displayPath, so none can carry a platform separator', () => {
    // A raw path.relative printed a backslash path on Windows in five places before this
    // guard existed. Containment checks compare, never print, and are the only exception.
    const allowed = new Set(['src/paths.ts', 'src/commands/accept.ts']);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith('.ts')) {
          const relative = file.split(path.sep).join('/');
          if (allowed.has(relative)) continue;
          if (readFileSync(file, 'utf8').includes('path.relative(')) offenders.push(relative);
        }
      }
    };
    walk('src');
    assert.deepEqual(offenders, []);
  });
});
