import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../config.ts';
import { displayPath } from '../paths.ts';

export interface ReportOptions {
  root: string;
}

/** Platform opener. The report is a plain file, so the desktop default is the right handler. */
function opener(): { command: string; args: string[] } {
  if (process.platform === 'darwin') return { command: 'open', args: [] };
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] };
  return { command: 'xdg-open', args: [] };
}

/** Open a file with the desktop default, detached — the CLI does not wait for the viewer. */
export function openWithDesktop(target: string): void {
  const { command, args } = opener();
  const child = spawn(command, [...args, target], { stdio: 'ignore', detached: true });
  child.on('error', () => {
    process.stdout.write(`${target}\n`);
  });
  child.unref();
}

export async function reportCommand(options: ReportOptions): Promise<number> {
  const { config } = await loadConfig(options.root);
  const reportPath = path.resolve(options.root, config.outputDir, 'report.html');

  if (!existsSync(reportPath)) {
    process.stderr.write(
      `No report at ${displayPath(options.root, reportPath)}. Run \`diopsis run\` first.\n`,
    );
    return 1;
  }

  openWithDesktop(reportPath);
  return 0;
}
