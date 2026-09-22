'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// npm.cmd cannot be launched with execFileSync on Windows. Invoke npm's
// JavaScript entry point with Node instead, retaining argv boundaries and
// avoiding a shell even when the installation or temporary path has spaces.
function npmInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform;
  const executable = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const candidates = [env.npm_execpath];
  if (platform === 'win32') {
    const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
    for (const directory of [paths.dirname(executable), ...searchPath.split(';').filter(Boolean)]) {
      candidates.push(paths.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  }
  const cli = candidates.find(candidate => candidate && paths.basename(candidate).toLowerCase() === 'npm-cli.js' && exists(candidate));
  if (cli) return { executable, args: [cli, ...args] };
  if (platform === 'win32') throw new Error('Cannot locate npm-cli.js. Run this check through npm run, or install npm alongside Node.');
  return { executable: 'npm', args };
}

function execNpmSync(args, options = {}) {
  const invocation = npmInvocation(args);
  return execFileSync(invocation.executable, invocation.args, options);
}

module.exports = { npmInvocation, execNpmSync };
