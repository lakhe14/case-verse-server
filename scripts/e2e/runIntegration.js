'use strict';

/**
 * npm run test:integration
 * 1. guard + fixture setup on the *_e2e database
 * 2. jest tests/integration (zero tests found is a failure)
 * 3. scoped cleanup + verification, attempted even when tests fail
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { loadE2eEnv, SERVER_ROOT } = require('./loadEnv');

function run(args, label) {
  const result = spawnSync(process.execPath, args, { cwd: SERVER_ROOT, env: process.env, stdio: 'inherit' });
  if (result.error) console.error(`${label}: ${result.error.message}`);
  return result.status ?? 1;
}

const { databaseName, runId } = loadE2eEnv({ mutation: true });
console.info(`Integration | database: ${databaseName} | run: ${runId}`);

let status = run([path.join(__dirname, 'setup.js')], 'setup');
if (status === 0) {
  status = run([
    path.join(SERVER_ROOT, 'node_modules', 'jest', 'bin', 'jest.js'),
    // Optional test-path filters first: --roots is an array flag and would swallow them.
    ...process.argv.slice(2),
    '--runInBand',
    '--testPathIgnorePatterns=/node_modules/',
    // Jest exits 1 when this directory has no tests; --passWithNoTests is deliberately absent.
    `--roots=${path.join(SERVER_ROOT, 'tests', 'integration')}`,
  ], 'jest');
}
const cleanupStatus = run([path.join(__dirname, 'cleanup.js'), '--verify'], 'cleanup');
process.exit(status || cleanupStatus);
