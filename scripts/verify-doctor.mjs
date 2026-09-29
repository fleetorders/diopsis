#!/usr/bin/env node
// Asserts a `diopsis doctor --json` document the way CI needs: on the structured fields
// (ok, level, counts), never on the human-readable titles, and with every failure naming
// what the document actually said — so a red run is readable from its log alone, without
// the temp file that only the runner can see.
//
// Wire it into the moment it protects:
//   .github/workflows/ci.yml compat job → after `doctor --json` writes its file
//   by hand                            → node scripts/verify-doctor.mjs <file> <stories> <captures>
//
// Usage: verify-doctor.mjs <doctor.json> <expected-stories> <expected-captures>
// Exits 0 when the document is a green doctor run with the expected counts, 1 on any
// assertion, 2 when it cannot be run at all. Warnings are allowed: doctor's own exit
// code treats them as passing, and so does this.

import { readFile } from 'node:fs/promises';

const [file, storiesArg, capturesArg] = process.argv.slice(2);
const stories = Number(storiesArg);
const captures = Number(capturesArg);

function fail(reason) {
  console.error(`› verify-doctor: ${reason}`);
  process.exit(1);
}

if (!file || !Number.isInteger(stories) || !Number.isInteger(captures)) {
  console.error('usage: verify-doctor.mjs <doctor.json> <expected-stories> <expected-captures>');
  process.exit(2);
}

let text;
try {
  text = await readFile(file, 'utf8');
} catch (error) {
  console.error(`› verify-doctor: cannot read ${file}: ${error.message}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(text);
} catch (error) {
  // A stray line around the document — a banner, a deprecation warning from a dependency —
  // is the failure this has to show: the file itself sits in CI's temp dir, not the log.
  const lines = text.split('\n');
  const shown =
    lines.length <= 12 ? lines : [...lines.slice(0, 6), '…', ...lines.slice(-6)];
  console.error(`› verify-doctor: ${file} is not one JSON document — ${error.message}`);
  console.error(shown.map((line) => `    ${line}`).join('\n'));
  process.exit(1);
}

const shaped =
  report !== null &&
  typeof report === 'object' &&
  report.diopsis === 1 &&
  typeof report.ok === 'boolean' &&
  Array.isArray(report.checks) &&
  report.checks.every(
    (check) =>
      typeof check?.level === 'string' &&
      ['ok', 'warn', 'fail'].includes(check.level) &&
      typeof check.title === 'string',
  );
if (!shaped) {
  fail(
    `${file} is not a diopsis doctor document (schema version 1: ok boolean, ` +
      'checks[{level, title}]) — the JSON output has changed shape.',
  );
}

if (!report.ok) {
  for (const check of report.checks.filter((check) => check.level !== 'ok')) {
    console.error(
      `    ${check.level === 'fail' ? '×' : '!'} ${check.title}` +
        (check.detail ? ` — ${check.detail}` : ''),
    );
  }
  fail('doctor reported failing checks');
}

const numeric = (value) => typeof value === 'number' && Number.isFinite(value);
const withCounts = report.checks.filter((check) => check.counts !== undefined);
if (
  withCounts.length !== 1 ||
  !numeric(withCounts[0].counts?.stories) ||
  !numeric(withCounts[0].counts?.captures)
) {
  fail(
    `expected exactly one check carrying numeric counts, found ${withCounts.length} — ` +
      `titles seen: ${report.checks.map((check) => check.title).join('; ')}`,
  );
}
const [matrix] = withCounts;
if (matrix.level !== 'ok') {
  fail(`the story-count check is ${matrix.level}: ${matrix.title}`);
}
if (matrix.counts.stories !== stories || matrix.counts.captures !== captures) {
  fail(
    `doctor counted ${matrix.counts.stories} stories → ${matrix.counts.captures} captures, ` +
      `expected ${stories} → ${captures}`,
  );
}

const warnings = report.checks.filter((check) => check.level === 'warn').length;
console.log(
  `› verify-doctor: ok — ${stories} stories → ${captures} captures` +
    (warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''),
);
