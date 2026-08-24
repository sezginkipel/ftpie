import { describe, expect, it } from 'vitest';

import { translate, type TKey } from '../lib/i18n';
import type { DeployPlan, GitStatus } from '../lib/types';
import {
  firstInvalidGlob,
  isValidGlob,
  parseExcludes,
  summarisePlan,
  upstreamLabel,
} from './GitPanel';

/** `t` bound to English, for the honest-upstream assertions. */
const t = (key: TKey, vars?: Record<string, string | number>) => translate('en', key, vars);

function plan(overrides: Partial<DeployPlan> = {}): DeployPlan {
  return {
    rev: 'main',
    branch: 'main',
    commitSha: 'a'.repeat(40),
    commit: null,
    baseCommitSha: null,
    remoteBasePath: '/var/www',
    includeUncommitted: false,
    uploads: [],
    deletes: [],
    skipped: [],
    totalBytes: 0,
    ...overrides,
  };
}

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    upstream: null,
    ahead: null,
    behind: null,
    changedFiles: [],
    isDirty: false,
    detached: false,
    lastCommit: null,
    ...overrides,
  };
}

describe('parseExcludes', () => {
  it('takes one glob per line and drops blanks and comments', () => {
    expect(parseExcludes('node_modules/**\n\n  *.map  \n# a comment\n.env')).toEqual([
      'node_modules/**',
      '*.map',
      '.env',
    ]);
  });

  it('yields an empty list for empty text, not [""]', () => {
    expect(parseExcludes('\n  \n')).toEqual([]);
  });
});

describe('isValidGlob', () => {
  it('accepts ordinary globset patterns', () => {
    for (const pattern of [
      'node_modules/**',
      '*.map',
      'dist/**/*.{js,css}',
      'log[0-9].txt',
      'a\\[b',
    ]) {
      expect(isValidGlob(pattern), pattern).toBe(true);
    }
  });

  it('rejects unbalanced brackets and braces', () => {
    for (const pattern of ['log[0-9.txt', 'dist/{a,b', 'a]b', 'x}y', '   ']) {
      expect(isValidGlob(pattern), pattern).toBe(false);
    }
  });

  it('reports the first offender so the field can name it', () => {
    expect(firstInvalidGlob(['*.map', 'dist/{a,b', '*.js'])).toBe('dist/{a,b');
    expect(firstInvalidGlob(['*.map', '*.js'])).toBeNull();
  });
});

describe('summarisePlan', () => {
  it('counts an empty plan as nothing to do', () => {
    const summary = summarisePlan(plan());
    expect(summary.empty).toBe(true);
    expect(summary.hasDeletions).toBe(false);
  });

  it('flags deletions separately, because they now propagate to the server', () => {
    const summary = summarisePlan(
      plan({
        uploads: [
          {
            path: 'a.js',
            remotePath: '/var/www/a.js',
            source: 'tree',
            blobSha: 'b'.repeat(40),
            size: 100,
            reason: 'modified',
          },
        ],
        deletes: [
          { path: 'old.js', remotePath: '/var/www/old.js', reason: 'deleted' },
          { path: 'gone.js', remotePath: '/var/www/gone.js', reason: 'renamed' },
        ],
        totalBytes: 100,
      }),
    );
    expect(summary.uploads).toBe(1);
    expect(summary.deletes).toBe(2);
    expect(summary.hasDeletions).toBe(true);
    expect(summary.empty).toBe(false);
    expect(summary.bytes).toBe(100);
  });

  it('counts uploads that came from the dirty working tree', () => {
    const summary = summarisePlan(
      plan({
        includeUncommitted: true,
        uploads: [
          {
            path: 'a.js',
            remotePath: '/var/www/a.js',
            source: 'worktree',
            blobSha: null,
            size: 10,
            reason: 'modified',
          },
          {
            path: 'b.js',
            remotePath: '/var/www/b.js',
            source: 'tree',
            blobSha: 'c'.repeat(40),
            size: 10,
            reason: 'added',
          },
        ],
      }),
    );
    // Worth surfacing: a worktree-sourced deploy is not reproducible.
    expect(summary.worktreeUploads).toBe(1);
  });

  it('counts skipped entries', () => {
    expect(summarisePlan(plan({ skipped: [{ path: 'link', reason: 'symlink' }] })).skipped).toBe(1);
  });
});

describe('upstreamLabel', () => {
  it('says "no upstream" instead of 0/0 when there is none', () => {
    expect(upstreamLabel(status({ ahead: null, behind: null }), t)).toBe('No upstream branch');
  });

  it('still says "no upstream" when only one side is null', () => {
    expect(upstreamLabel(status({ ahead: 3, behind: null }), t)).toBe('No upstream branch');
  });

  it('reports genuine zeroes as zeroes', () => {
    expect(upstreamLabel(status({ upstream: 'origin/main', ahead: 0, behind: 0 }), t)).toBe(
      '0 ahead, 0 behind',
    );
  });

  it('reports real divergence', () => {
    expect(upstreamLabel(status({ upstream: 'origin/main', ahead: 2, behind: 5 }), t)).toBe(
      '2 ahead, 5 behind',
    );
  });
});
