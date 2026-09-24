'use strict';

const app = require('./app');
const env = require('./config/env');
const { assertDatabaseConnection } = require('./config/database');
const { logProcessError } = require('./utils/safeLog');

// Never let Node print a raw message or stack for an escaped failure.
process.on('unhandledRejection', (reason) => {
  logProcessError('unhandled_rejection', reason);
});
process.on('uncaughtException', (error) => {
  logProcessError('uncaught_exception', error);
  process.exit(1);
});

async function start() {
  try {
    await assertDatabaseConnection();
    console.info('Database connection OK');
  } catch (err) {
    // Driver messages can name hosts and users: log the category and code only.
    logProcessError('database_connect_failed', err);
    process.exit(1);
  }

  const server = app.listen(env.port, () => {
    if (env.isE2e) {
      console.info(`E2E MODE | database: ${env.db.name} | port: ${env.port} | shipping: ${env.parcelmooverStub ? 'e2e-stub' : 'live ParcelMoover'}`);
    }
    console.info(`CaseVerse API listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  const shutdown = (signal) => {
    console.info(`\n${signal} received, shutting down...`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
