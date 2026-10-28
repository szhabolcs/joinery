import { describe, expect, test } from 'bun:test';
import type { FileEntry, Review } from '@joinery/core';
import { buildReadingOrderTask } from '../../src/agent/readingOrder.ts';
import { buildReviewContext } from '../../src/agent/reviewContext.ts';

const review = { branch: 'feature', pinnedSha: null, baseRef: 'main', prNumber: null } as Review;

/** What a reading-order run sends: the shared review context, then its task. */
function buildReadingOrderPrompt(files: FileEntry[]): string {
  const repo = { remoteOwner: null, remoteName: null, rootPath: '/repo' };
  return `${buildReviewContext({ review, repo, pull: null, readingOrderTitles: [], files })}\n\n${buildReadingOrderTask()}`;
}

function file(overrides: Partial<FileEntry>): FileEntry {
  return {
    path: 'foo.ts',
    oldPath: null,
    status: 'modified',
    oldBlob: 'a'.repeat(40),
    newBlob: 'b'.repeat(40),
    binary: false,
    generated: false,
    additions: 3,
    deletions: 1,
    ...overrides,
  };
}

describe('buildReadingOrderPrompt (reading_order run)', () => {
  test('lists every changed file by exact path', () => {
    const files = [file({ path: 'apps/server/src/agent/runs.ts' }), file({ path: 'SPEC.md', status: 'added', oldPath: null })];
    const prompt = buildReadingOrderPrompt(files);
    expect(prompt).toContain('apps/server/src/agent/runs.ts');
    expect(prompt).toContain('SPEC.md');
  });

  test('surfaces rename provenance and binary/added/deleted status', () => {
    const files = [
      file({ path: 'new-name.ts', oldPath: 'old-name.ts', status: 'renamed' }),
      file({ path: 'image.png', status: 'added', binary: true, additions: null, deletions: null }),
    ];
    const prompt = buildReadingOrderPrompt(files);
    expect(prompt).toContain('renamed from old-name.ts');
    expect(prompt).toContain('[binary]');
  });

  test('instructs the agent to place every file in exactly one step and to only emit structured output', () => {
    const prompt = buildReadingOrderPrompt([file({})]);
    expect(prompt).toMatch(/exactly one step/);
    expect(prompt).toMatch(/only.*structured output/i);
  });
});
