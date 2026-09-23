'use strict';

const app = require('./app');
const env = require('./config/env');
const { assertDatabaseConnection } = require('./config/database');

async function start() {
  try {
    await assertDatabaseConnection();
    console.info('Database connection OK');
  } catch (err) {
    console.error('Failed to connect to the database:', err.message);
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
