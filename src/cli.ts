#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { acceptCommand } from './commands/accept.ts';
import { diffCommand } from './commands/diff.ts';
import { doctorCommand } from './commands/doctor.ts';
import { initCommand } from './commands/init.ts';
import { pruneCommand } from './commands/prune.ts';
import { reportCommand } from './commands/report.ts';
import { runCommand } from './commands/run.ts';

const USAGE = `diopsis — visual regression for Storybook

Usage
  diopsis init                 scaffold a config, git settings and a CI recipe
  diopsis run                  verify against committed baselines   (default)
  diopsis update               regenerate baselines
  diopsis accept [story-id...] adopt the last run's output as the baseline
  diopsis diff [base]          review the baseline changes a branch makes
  diopsis prune                delete baselines no capture would write (dry run by default)
  diopsis report               open the last report
  diopsis doctor               audit the setup for what silently breaks a baseline set
  diopsis help                 show this message

Options belong to their command; a flag another command takes is refused here.
  run, update   --grep <text>   only stories whose id contains <text>
                --keep          keep the generated Playwright project
  accept        --no-stage      accept without staging the result in git
  diff          --open          open the report after writing it
                --platform <t>  only baselines of one platform token, e.g. linux-x64
  prune         --yes           delete the listed baselines instead of a dry run
                --platform <t>  only baselines of one platform token, e.g. linux-x64
  init          --force         overwrite an existing config
                --lfs           set the baselines up for Git LFS
  doctor        --json          print the checks as JSON instead of prose
  any command   --help          show this message
  diopsis --version | -v        print the version

Playwright options go after --, e.g. diopsis run -- --shard=1/2.
`;

/**
 * The flags each command accepts. Everything else parses — so the error can name the flag
 * rather than dying on an unknown option — and is then refused for this command, because a
 * silently ignored flag (`accept --grep x` accepting the whole run) is worse than an error.
 */
const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  run: new Set(['grep', 'keep', 'help']),
  update: new Set(['grep', 'keep', 'help']),
  accept: new Set(['no-stage', 'help']),
  diff: new Set(['open', 'platform', 'help']),
  prune: new Set(['yes', 'platform', 'help']),
  init: new Set(['force', 'lfs', 'help']),
  doctor: new Set(['json', 'help']),
  report: new Set(['help']),
  help: new Set(['help']),
};

/** Read beside this module, so the version is found from `src/` in development and from `dist/` installed. */
function version(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: string };
  return manifest.version ?? 'unknown';
}

export async function main(argv: string[]): Promise<number> {
  const first = argv[0];
  if (first === '--version' || first === '-v') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  const command = first && !first.startsWith('-') ? first : 'run';
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) {
    process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
    return 1;
  }

  const rest = first && !first.startsWith('-') ? argv.slice(1) : argv;
  let values: { grep?: string; keep?: boolean; force?: boolean; lfs?: boolean; json?: boolean; open?: boolean; platform?: string; yes?: boolean; 'no-stage'?: boolean; help?: boolean };
  let positionals: string[];
  let usedFlags: string[];
  try {
    const parsed = parseArgs({
      args: rest,
      options: {
        grep: { type: 'string' },
        keep: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        lfs: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        open: { type: 'boolean', default: false },
        platform: { type: 'string' },
        yes: { type: 'boolean', default: false },
        'no-stage': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
    usedFlags = parsed.tokens
      .filter((token) => token.kind === 'option')
      .map((token) => token.name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unknown = /Unknown option '(-+[^']*)'/.exec(message)?.[1];
    if (unknown) {
      process.stderr.write(
        `diopsis ${command} does not take --${unknown.replace(/^-+/, '')}.\n` +
          'Playwright options go after --, e.g. diopsis run -- --shard=1/2.\n' +
          `\n${USAGE}`,
      );
    } else {
      process.stderr.write(`${message}\n\n${USAGE}`);
    }
    return 1;
  }

  const stray = [...new Set(usedFlags)].find((name) => !allowed.has(name));
  if (stray) {
    process.stderr.write(`diopsis ${command} does not take --${stray}.\n\n${USAGE}`);
    return 1;
  }

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const root = process.cwd();

  switch (command) {
    case 'run':
    case 'update':
      return runCommand({
        root,
        update: command === 'update',
        ...(values.grep ? { grep: values.grep } : {}),
        keep: values.keep,
        passthrough: positionals,
      });
    case 'accept':
      return acceptCommand({
        root,
        ...(positionals.length > 0 ? { storyIds: positionals } : {}),
        noStage: values['no-stage'],
      });
    case 'diff':
      if (positionals.length > 1) {
        process.stderr.write(`diopsis diff takes one base ref at most.\n\n${USAGE}`);
        return 1;
      }
      return diffCommand({
        root,
        ...(positionals.length > 0 ? { base: positionals[0] } : {}),
        open: values.open,
        ...(values.platform ? { platform: values.platform } : {}),
      });
    case 'init':
      return initCommand({ root, force: values.force, lfs: values.lfs });
    case 'prune':
      if (positionals.length > 0) {
        process.stderr.write(`diopsis prune takes no story ids.\n\n${USAGE}`);
        return 1;
      }
      return pruneCommand({
        root,
        yes: values.yes,
        ...(values.platform ? { platform: values.platform } : {}),
      });
    case 'doctor':
      return doctorCommand({ root, json: values.json });
    case 'report':
      return reportCommand({ root });
    default:
      process.stdout.write(USAGE);
      return 0;
  }
}

const entry = process.argv[1];
if (entry && pathToFileURL(realpathSync(entry)).href === import.meta.url) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
