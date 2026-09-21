# CaseVerse Server

Node.js, Express, Sequelize, and MySQL API for the CaseVerse iPhone-cover
ecommerce application.

## Requirements

- Node.js 18 or newer
- MySQL 8

## Setup

```bash
cd server
copy .env.example .env
npm install
```

Configure the database connection and distinct JWT secrets in the local
`server/.env` file. This file is ignored by Git and must never be committed.

## Database

```bash
npm run db:init
npm run db:seed
```

`db:init` creates the database when permitted and applies the sibling
`../schema.sql` schema. `db:seed` creates RBAC roles, permissions, and safe demo
catalogue data without source-controlled account passwords.

## Local development accounts

Set the local-only `DEV_*` values in `server/.env`, then run:

```bash
npm run dev:reset-accounts
```

The command is idempotent and intentionally refuses to run with
`NODE_ENV=production`. Do not commit or document its passwords in this repository.

## Run and test

```bash
npm run dev
npm test
```

For a production-style local start, use `npm start`.

## API notes

- Storefront API routes are mounted beneath `/api`.
- Customer and staff authentication use access and refresh tokens.
- Administrative routes are guarded by the existing RBAC permissions.
- Product catalogue images may be stored in `uploads/`; private/customer upload
  directories are excluded from version control.

## Security

- Use only server-side environment variables for database credentials, JWT
  secrets, SMTP credentials, and other private configuration.
- Do not commit `.env` files, database exports, portable MySQL data, logs, or
  customer payment proofs.
