# CaseVerse database backup and restore

Two layers:

1. **Provider backups** (managed MySQL automated daily backups / point-in-time
   recovery). Turn them on when the database is created and note the
   retention period.
2. **Independent logical backups** with `mysqldump`, stored off the database
   provider, so a provider/account problem cannot take the only copy.

Payment proofs and uploaded product images live on the Render disk, not in
MySQL. Render snapshots the disk daily (kept at least 7 days); download a
copy of `/var/data` periodically as well.

The procedure below was rehearsed locally: a fresh database built with
`npm run db:migrate`, and a read-only dump of a populated database, were each
restored into a disposable database and every table's row count matched.

## Backup

Use a dedicated read-only account for backups if the provider allows it
(`SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES`, plus `PROCESS` if the
provider requires it for consistent dumps). Keep the password out of the
command line and shell history: use `MYSQL_PWD` for one command or an option
file with `chmod 600`.

```sh
# consistent snapshot of InnoDB tables without locking the shop
MYSQL_PWD="$BACKUP_PASSWORD" mysqldump \
  --host="$DB_HOST" --port="$DB_PORT" --user="$BACKUP_USER" \
  --ssl-mode=REQUIRED \
  --single-transaction --quick \
  --routines --triggers --events \
  --no-tablespaces --set-gtid-purged=OFF \
  --default-character-set=utf8mb4 \
  caseverse_staging \
  | gzip > "caseverse_staging_$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
```

- `--set-gtid-purged=OFF` avoids GTID statements that managed servers
  often reject on restore; drop it if the provider documents otherwise.
- Add `--ssl-ca=/path/ca.pem` if the provider requires its CA.
- Store the file encrypted, off-host, with at least 14 days of history. It
  contains customer data: never commit it, email it or leave it on a laptop.

Suggested cadence for launch: provider daily backups plus a weekly
`mysqldump` (daily once orders are regular).

## Restore (always into a NEW database first)

Never restore over the live database as a first step.

```sh
# 1. new, empty database (on the provider, or a local MySQL 8)
MYSQL_PWD="$ADMIN_PASSWORD" mysql --host="$DB_HOST" --port="$DB_PORT" \
  --user="$ADMIN_USER" --ssl-mode=REQUIRED \
  -e "CREATE DATABASE caseverse_restore_check CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

# 2. load the dump
gunzip -c caseverse_staging_YYYYMMDDTHHMMSSZ.sql.gz | \
  MYSQL_PWD="$ADMIN_PASSWORD" mysql --host="$DB_HOST" --port="$DB_PORT" \
  --user="$ADMIN_USER" --ssl-mode=REQUIRED caseverse_restore_check
```

## Verify the restored copy

```sql
-- every table present (32 at the time of writing)
SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'caseverse_restore_check';

-- critical tables: compare with the source at backup time
SELECT 'orders', COUNT(*) FROM caseverse_restore_check.orders
UNION ALL SELECT 'order_items', COUNT(*) FROM caseverse_restore_check.order_items
UNION ALL SELECT 'order_payment_confirmations', COUNT(*) FROM caseverse_restore_check.order_payment_confirmations
UNION ALL SELECT 'inventory_reservations', COUNT(*) FROM caseverse_restore_check.inventory_reservations
UNION ALL SELECT 'product_variants', COUNT(*) FROM caseverse_restore_check.product_variants
UNION ALL SELECT 'users', COUNT(*) FROM caseverse_restore_check.users
UNION ALL SELECT 'staff', COUNT(*) FROM caseverse_restore_check.staff
UNION ALL SELECT 'coupon_usages', COUNT(*) FROM caseverse_restore_check.coupon_usages;

-- stock totals match
SELECT SUM(stock_quantity) FROM caseverse_restore_check.product_variants;
```

Schema version: the latest migration's changes must be present, e.g.

```sql
SHOW INDEX FROM caseverse_restore_check.coupon_usages WHERE Key_name = 'idx_coupon_usage_active';
SHOW COLUMNS FROM caseverse_restore_check.orders LIKE 'cancellation_reason';
```

Optionally point a throwaway API at the restored copy (never the live
storefront) and check `GET /api/health` and a product page. Running
`DATABASE_URL=<restore copy> npm run db:migrate` on it must report
"schema already present" and change nothing.

Drop the check database when done:
`DROP DATABASE caseverse_restore_check;`

## Real recovery

1. Stop writes: suspend the Render web service and cron job.
2. Restore the chosen backup into a new database and verify it as above.
3. Point `DATABASE_URL` / `MIGRATION_DATABASE_URL` of both Render services at
   it (or rename per the provider's procedure), resume, run the staging QA
   smoke checks.
4. Keep the old database untouched until the recovery is confirmed.

## Restore drill

Repeat the backup → new database → verify cycle before launch and at least
monthly, and record the date and result in `docs/STAGING_QA.md` item 41.
