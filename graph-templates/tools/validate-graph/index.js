#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { validate } = require('./validate');

if (require.main === module) {
  const projectDir = path.resolve(process.argv[2] || '.');
  const templatesRoot = path.resolve(process.argv[3] || path.join(__dirname, '..', '..'));
  const result = validate(projectDir, templatesRoot);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.valid ? 0 : 1;
}

module.exports = { validate, ...require('./contracts') };
