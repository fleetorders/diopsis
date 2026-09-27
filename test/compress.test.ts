import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  recompressBaselines,
  writeRecompressReport,
  type RecompressOutcome,
} from '../src/compress.ts';
import { encodePng } from '../src/png-encode.ts';
import { crc32 } from '../src/png.ts';

const temporaries: string[] = [];

afterEach(async () => {
  delete process.env.DIOPSIS_OXIPNG;
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Both streams, captured, so the one line each path prints can be asserted on exactly. */
function capture(print: () => void): { out: string; err: string } {
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof writeOut;
  process.stderr.write = ((chunk: unknown) => {
    err += String(chunk);
    return true;
  }) as typeof writeErr;
  try {
    print();
    return { out, err };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

/**
 * An executable stand-in for oxipng, so every path through recompression runs on a machine
 * without the tool — including one that has it, where the default name would find it.
 */
async function fakeOxipng(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-oxipng-'));
  temporaries.push(dir);
  const script = path.join(dir, 'oxipng');
  await writeFile(script, `#!/bin/sh\n${body}\n`, 'utf8');
  await chmod(script, 0o755);
  return script;
}

/** A flat shade, as a screenshot's pixels: every byte of it differs from another shade's. */
function shade(width: number, height: number, value: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let at = 0; at < out.length; at += 4) {
    out[at] = value;
    out[at + 1] = value;
    out[at + 2] = value;
    out[at + 3] = 255;
  }
  return out;
}

/** A written baseline and the exact bytes it was written with. */
async function baseline(
  dir: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ file: string; bytes: Uint8Array }> {
  const file = path.join(dir, '__screenshots__', name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return { file, bytes };
}

/** The same image, made heavier: one ancillary chunk of padding, identical pixels. */
function padded(original: Uint8Array, junk: number): Buffer {
  const type = Buffer.from('tEXt', 'ascii');
  const data = Buffer.alloc(junk, 0x61);
  const chunk = Buffer.alloc(8 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  // Straight after IHDR: the 8-byte signature, then its length, type, data and CRC.
  const after = 8 + 4 + 4 + 13 + 4;
  return Buffer.concat([original.subarray(0, after), chunk, original.subarray(after)]);
}

describe('recompressBaselines', () => {
  it('reports the tool missing with one line, and leaves every file byte-identical', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-compress-'));
    temporaries.push(dir);
    const written = await baseline(dir, 'a--one/320w-darwin-arm64.png', encodePng(4, 3, shade(4, 3, 120)));

    // A name that resolves nowhere stands in for a PATH without oxipng.
    process.env.DIOPSIS_OXIPNG = 'oxipng-absent-for-this-test';
    const outcome = await recompressBaselines({ files: [written.file], root: dir });
    assert.equal(outcome.kind, 'missing');

    const { out, err } = capture(() => writeRecompressReport(outcome));
    assert.equal(out, '');
    assert.equal(
      err,
      'compress is auto, but oxipng is not installed — baselines are written uncompressed ' +
        '(see https://github.com/oxipng/oxipng)\n',
    );
    assert.ok((await readFile(written.file)).equals(Buffer.from(written.bytes)));
  });

  it('restores the original bytes when the tool changes pixels, and warns naming the file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-compress-'));
    temporaries.push(dir);
    const written = await baseline(dir, 'b--two/320w-darwin-arm64.png', encodePng(4, 3, shade(4, 3, 120)));
    const altered = path.join(dir, 'altered.png');
    await writeFile(altered, encodePng(4, 3, shade(4, 3, 90)));

    process.env.DIOPSIS_OXIPNG = await fakeOxipng(
      `if [ "$1" = "--version" ]; then exit 0; fi
for file in "$@"; do
  if [ -f "$file" ]; then cp "${altered}" "$file"; fi
done`,
    );
    const outcome = await recompressBaselines({ files: [written.file], root: dir });
    assert.ok(outcome.kind === 'done');
    assert.equal(outcome.compressed, 0);
    assert.deepEqual(outcome.restored, ['__screenshots__/b--two/320w-darwin-arm64.png']);

    const { err } = capture(() => writeRecompressReport(outcome));
    assert.match(err, /was not lossless for __screenshots__\/b--two\/320w-darwin-arm64\.png/);
    assert.match(err, /original baseline was restored/);
    assert.ok((await readFile(written.file)).equals(Buffer.from(written.bytes)));
  });

  it('keeps recompressed bytes that decode to the same pixels, and reports what they saved', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-compress-'));
    temporaries.push(dir);
    const clean = encodePng(4, 3, shade(4, 3, 120));
    const written = await baseline(dir, 'c--three/320w-darwin-arm64.png', padded(clean, 2048));
    const lean = path.join(dir, 'lean.png');
    await writeFile(lean, clean);

    process.env.DIOPSIS_OXIPNG = await fakeOxipng(
      `if [ "$1" = "--version" ]; then exit 0; fi
for file in "$@"; do
  if [ -f "$file" ]; then cp "${lean}" "$file"; fi
done`,
    );
    const outcome = await recompressBaselines({ files: [written.file], root: dir });
    assert.ok(outcome.kind === 'done');
    assert.equal(outcome.compressed, 1);
    assert.deepEqual(outcome.restored, []);
    assert.ok(outcome.bytesAfter < outcome.bytesBefore);
    assert.ok((await readFile(written.file)).equals(Buffer.from(clean)));

    const { out } = capture(() => writeRecompressReport(outcome));
    assert.match(out, /Recompressed 1 baseline with oxipng — [0-9.]+ [KMG]?B → [0-9.]+ [KMG]?B/);
  });

  it('hands the tool at most 100 files per invocation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-compress-'));
    temporaries.push(dir);
    const files: string[] = [];
    for (let at = 0; at < 250; at++) {
      const written = await baseline(
        dir,
        `s--story/shot-${at}-darwin-arm64.png`,
        encodePng(1, 1, shade(1, 1, at % 256)),
      );
      files.push(written.file);
    }
    const calls = path.join(dir, 'calls');

    process.env.DIOPSIS_OXIPNG = await fakeOxipng(
      `if [ "$1" = "--version" ]; then exit 0; fi
files=0
for arg in "$@"; do
  if [ -f "$arg" ]; then files=$((files + 1)); fi
done
echo "$files" >> "${calls}"`,
    );
    const outcome = await recompressBaselines({ files, root: dir });
    assert.ok(outcome.kind === 'done');
    assert.equal(outcome.compressed, 250);
    assert.deepEqual(outcome.restored, []);
    // The version probe is not a batch: three invocations, 100 + 100 + 50.
    assert.deepEqual((await readFile(calls, 'utf8')).split('\n').filter(Boolean), [
      '100',
      '100',
      '50',
    ]);
  });
});
