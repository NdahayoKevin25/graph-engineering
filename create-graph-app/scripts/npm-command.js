'use strict';

// The release scripts already require a built dist/. Share the same portable
// invocation used by generated-app dependency installation in the shipped CLI.
module.exports = require('../dist/utils/npm');
