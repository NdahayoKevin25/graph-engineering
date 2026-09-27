import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';

export interface NpmInvocationOptions {
  platform?: NodeJS.Platform;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
}

/** Invoke npm's JavaScript entrypoint rather than an unsafe Windows command shell. */
export function npmInvocation(args: string[], options: NpmInvocationOptions = {}): { executable: string; args: string[] } {
  const platform = options.platform ?? process.platform;
  const executable = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const candidates: (string | undefined)[] = [env.npm_execpath];
  if (platform === 'win32') {
    const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
    for (const directory of [paths.dirname(executable), ...searchPath.split(';').filter(Boolean)]) {
      candidates.push(paths.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  }
  const cli = candidates.find((candidate): candidate is string => Boolean(candidate && paths.basename(candidate).toLowerCase() === 'npm-cli.js' && exists(candidate)));
  if (cli) return { executable, args: [cli, ...args] };
  if (platform === 'win32') throw new Error('Cannot locate npm-cli.js. Run through npm, or install npm alongside Node.');
  return { executable: 'npm', args };
}

export function execNpmSync(args: string[], options: ExecFileSyncOptions = {}): Buffer | string {
  const invocation = npmInvocation(args);
  return execFileSync(invocation.executable, invocation.args, options);
}
