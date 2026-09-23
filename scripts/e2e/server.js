'use strict';

/**
 * Starts the API against the isolated E2E database (default port 4010).
 * `--setup` first runs the guarded fixture setup in a child process.
 *
 * Usage: npm run e2e:server   |   npm run e2e:server:fresh
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { loadE2eEnv } = require('./loadEnv');

const fresh = process.argv.includes('--setup');
loadE2eEnv({ mutation: fresh });
if (fresh) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'setup.js')], { env: process.env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
require('../../server');
