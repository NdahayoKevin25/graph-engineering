import { describe, expect, it } from 'vitest';

const { npmInvocation } = require('../scripts/npm-command.js');

describe('portable npm script invocation', () => {
  it('uses Node and npm-cli.js with separate arguments on Windows', () => {
    const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const args = ['pack', '--pack-destination', 'C:\\Users\\Example User\\Temp\\package', '--json'];
    expect(npmInvocation(args, { platform: 'win32', execPath: node, env: { npm_execpath: cli }, exists: (file: string) => file === cli }))
      .toEqual({ executable: node, args: [cli, ...args] });
  });
  it('finds npm next to Node when invoked directly instead of through npm run', () => {
    const node = 'C:\\nodejs\\node.exe';
    const cli = 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    expect(npmInvocation(['test'], { platform: 'win32', execPath: node, env: {}, exists: (file: string) => file === cli }))
      .toEqual({ executable: node, args: [cli, 'test'] });
  });
  it('handles the mixed-case Windows Path environment variable', () => {
    const cli = 'C:\\Users\\Example User\\npm\\node_modules\\npm\\bin\\npm-cli.js';
    expect(npmInvocation(['test'], { platform: 'win32', execPath: 'C:\\node\\node.exe', env: { Path: 'C:\\Users\\Example User\\npm' }, exists: (file: string) => file === cli }).args)
      .toEqual([cli, 'test']);
  });
  it('does not fall back to an unsafe command-shell invocation on Windows', () => {
    expect(() => npmInvocation(['pack'], { platform: 'win32', execPath: 'C:\\node\\node.exe', env: {}, exists: () => false }))
      .toThrow('Cannot locate npm-cli.js');
  });
  it('retains direct npm execution on POSIX when outside an npm lifecycle', () => {
    expect(npmInvocation(['pack'], { platform: 'linux', env: {}, exists: () => false }))
      .toEqual({ executable: 'npm', args: ['pack'] });
  });
});
