'use strict';

const { Sequelize } = require('sequelize');
const env = require('./env');

const dialectOptions = {};
if (env.db.ssl) {
  dialectOptions.ssl = { minVersion: 'TLSv1.2', rejectUnauthorized: env.db.sslRejectUnauthorized };
  if (env.db.sslCa) dialectOptions.ssl.ca = env.db.sslCa;
}

const sequelize = new Sequelize(env.db.name, env.db.user, env.db.password, {
  host: env.db.host,
  port: env.db.port,
  dialect: 'mysql',
  dialectOptions,
  logging: env.nodeEnv === 'development' ? (msg) => console.debug(msg) : false,
  define: {
    // schema.sql owns table/column names; models opt in to snake_case explicitly.
    underscored: true,
    freezeTableName: true,
    timestamps: false,
  },
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
  timezone: '+00:00',
});

async function assertDatabaseConnection() {
  await sequelize.authenticate();
}

module.exports = { sequelize, assertDatabaseConnection };
