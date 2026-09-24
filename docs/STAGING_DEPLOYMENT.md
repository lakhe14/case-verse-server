# CaseVerse staging deployment

Staging mirrors production: Vercel (storefront + admin SPA), Render (API +
stale-order cron), managed MySQL 8, a Render persistent disk for payment
proofs and admin-uploaded product images. Nothing here is created
automatically; each step is done by a person in the provider dashboards.
Never put a secret in this repository, in `render.yaml`, or in any `VITE_*`
variable.

Suggested staging hosts (provider domains are fine; custom domains come later):

| Part | Host (example) |
| --- | --- |
| Storefront | `https://caseverse-staging.vercel.app` |
| API | `https://caseverse-api-staging.onrender.com` |

## 1. Database (managed MySQL 8)

1. Create a MySQL 8 service in Singapore (closest to both Nepal and Render
   `singapore`). Require TLS. Turn on automated backups.
2. Create an empty database, e.g. `caseverse_staging` (its name must not be
   `caseverse_db`, `caseverse_e2e` or contain `test`).
3. Create two accounts (never use the provider's admin/root account in the app):

   ```sql
   -- runs migrations only (Render pre-deploy)
   CREATE USER 'caseverse_migrator'@'%' IDENTIFIED BY '<generated>';
   GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
     ON caseverse_staging.* TO 'caseverse_migrator'@'%';

   -- the running API and cron
   CREATE USER 'caseverse_app'@'%' IDENTIFIED BY '<generated>';
   GRANT SELECT, INSERT, UPDATE, DELETE ON caseverse_staging.* TO 'caseverse_app'@'%';
   ```

   These are exactly the grants the project was verified with (fresh schema +
   all migrations as the migrator; the whole API, seeds and cron as the app
   user). Migrations need no `DROP` privilege.
4. Allow connections from Render (provider "trusted sources"/firewall). Render
   services have shared outbound IPs listed in the Render dashboard
   (service → Connect → Outbound).
5. Connection URLs use TLS:
   `mysql://USER:PASSWORD@HOST:PORT/caseverse_staging?ssl-mode=REQUIRED`.
   If the provider requires its CA certificate, set `DB_CA_CERT` (PEM contents)
   and keep `DB_SSL_REJECT_UNAUTHORIZED` at its default `true`.

## 2. API on Render (`render.yaml`)

Apply the Blueprint from the server repository (Render → Blueprints → New).
It defines:

| Service | Type | Purpose |
| --- | --- | --- |
| `caseverse-api-staging` | web, `starter`, Singapore | Express API, health check `/api/health` |
| `caseverse-cancel-expired-staging` | cron, `*/15 * * * *` | `npm run orders:cancel-expired -- --execute` |

- Build: `npm ci` (Node version from `.node-version`, 24).
- Pre-deploy (every deploy, before traffic switches):
  `DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:migrate`
  (Render runs this in a Linux shell. It applies `db/schema.sql` to an empty
  database, then every migration in order; it is safe to re-run and never
  drops anything.)
- Start: `npm start`.
- Disk `caseverse-staging-data` mounted at `/var/data` (1 GB):
  `PRIVATE_UPLOAD_DIR=/var/data/payment-proofs` (private, only readable through
  the authenticated staff proof endpoint) and `UPLOAD_DIR=/var/data/uploads`
  (public product images at `/uploads/...`). A disk means a single instance
  and a brief restart gap on each deploy. Render snapshots disks daily and
  keeps snapshots for at least 7 days. The disk is not available to the
  pre-deploy step or the cron job (neither needs it).
- `autoDeployTrigger: off`: deploy staging deliberately.

### Server environment variables (names only)

Set in `render.yaml` (non-secret, may be changed in the dashboard):

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `production`; turns on the production configuration check |
| `PRIVATE_UPLOAD_DIR` | payment proofs on the disk (absolute, outside `UPLOAD_DIR`) |
| `UPLOAD_DIR` | public product images on the disk |
| `PAYMENT_ADVANCE_AMOUNT` | eSewa advance in NPR (100) |
| `PAYMENT_PROVIDER` | label shown with the advance (eSewa) |
| `RESERVATION_TTL_MINUTES` | unpaid / rejected-proof stock hold (60) |
| `RESERVATION_REVIEW_TTL_HOURS` | COD confirmation window (72) |
| `PAYMENT_PROOF_REVIEW_SLA_HOURS` | "Review overdue" display threshold (72); never cancels |
| `PARCELMOOVER_BASE_URL` | ParcelMoover API base URL |
| `PARCELMOOVER_DEFAULT_WEIGHT_KG` | parcel weight used for quotes |
| `GEOCODER_BASE_URL` | reverse geocoder for checkout "Use my location" (public OSM Nominatim; LocationIQ or self-hosted Nominatim by changing it) |

Entered in the dashboard (`sync: false`, secrets or per-environment):

| Variable | Web | Cron | Purpose |
| --- | --- | --- | --- |
| `CLIENT_ORIGIN` | yes | yes | exact storefront origin(s), https, comma-separated, no wildcard |
| `DATABASE_URL` | yes | yes | `caseverse_app` connection URL (TLS) |
| `MIGRATION_DATABASE_URL` | yes | no | `caseverse_migrator` connection URL, used only by the pre-deploy step |
| `JWT_ACCESS_SECRET` | yes | yes | random, at least 32 characters |
| `JWT_REFRESH_SECRET` | yes | yes | random, at least 32 characters, different |
| `GUEST_REPLAY_SECRET` | yes | yes | random, at least 32 characters, different from both JWT secrets |
| `PARCELMOOVER_API_KEY` | yes | yes | ParcelMoover key (server only) |
| `GEOCODER_CONTACT` | yes | no | support URL or email sent in the geocoder User-Agent (Nominatim usage policy) |
| `GEOCODER_API_KEY` | optional | no | only for a keyed provider such as LocationIQ (server only) |

The cron job must use the same database, secrets and origin as the web
service. Generate each secret separately, e.g.
`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

Optional: `DB_CA_CERT`, `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED`,
`JWT_ACCESS_TTL` (15m), `JWT_REFRESH_TTL` (30d), `MAX_UPLOAD_MB`,
`LOYALTY_EARN_RATE`, `LOYALTY_POINT_VALUE`, `PORT` (Render sets it).

`NODE_ENV=production` refuses to start if a secret is missing, short, a
placeholder or reused; if `CLIENT_ORIGIN` is not https (or is localhost /
wildcard); if the database user is `root` or the database is a dev/E2E/test
one; if `PRIVATE_UPLOAD_DIR` is relative or inside `UPLOAD_DIR`; or if the
ParcelMoover settings are missing. The error names the variable, never the
value.

## 3. One-time initialisation (Render shell on the web service)

1. First deploy runs the migrations (pre-deploy).
2. Roles and permissions (idempotent; never the demo seed, which refuses to
   run in production):

   ```sh
   npm run db:seed-rbac
   ```

3. First Super Admin. Set three temporary variables on the web service
   (or inline for this one command), run, then delete them:

   ```sh
   BOOTSTRAP_ADMIN_NAME='...' BOOTSTRAP_ADMIN_EMAIL='...' BOOTSTRAP_ADMIN_PASSWORD='...' \
     npm run staff:bootstrap-admin
   ```

   - password: 14+ characters, three of lower/upper/digit/symbol, not based on
     the name, email, "caseverse" or "password"
   - prints only the email's domain; re-running for the same email changes
     nothing; it refuses once any active Super Admin exists (add other staff
     in the admin UI)
   - afterwards remove `BOOTSTRAP_ADMIN_PASSWORD` (and the other two) from the
     provider environment and shell history.
4. Import the catalogue as needed through the admin UI.

## 4. Storefront on Vercel (client repository)

`vercel.json` in the client repo sets the Vite framework, `npm run build`,
output `dist`, a rewrite of every path to `/index.html` (static files are
served first, so `/assets/...` is unaffected) so deep links like
`/p/<slug>`, `/checkout`, `/order/guest/<token>`, `/account/orders` and
`/admin/...` work on refresh, and `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.

Client environment variables (Vercel project → Settings → Environment
Variables). All `VITE_*` values are PUBLIC: they are compiled into the
JavaScript every visitor downloads.

| Variable | Purpose |
| --- | --- |
| `VITE_API_URL` | API origin, e.g. `https://caseverse-api-staging.onrender.com` (https, no path). Vercel builds fail without a valid value. |
| `VITE_WHATSAPP_NUMBER` | business WhatsApp number for the contact / COD links |
| `VITE_WHATSAPP_GREETING` | prefilled WhatsApp text |
| `VITE_CONTACT_EMAIL` | footer contact email (blank hides it) |

Admin-uploaded product images are stored by the API and referenced as
`/uploads/...`; the storefront loads them from `VITE_API_URL`, and the API
marks only `/uploads` as embeddable cross-origin. Payment proofs are never
under `/uploads`.

## 5. CORS

`CLIENT_ORIGIN` on both Render services must be exactly the storefront origin
(e.g. `https://caseverse-staging.vercel.app`, no trailing slash). The API
answers preflight `OPTIONS` requests and allows `Authorization`,
`Content-Type` and multipart uploads from that origin only. Vercel preview
deployments have other origins and will be refused unless added explicitly.

## 6. Known gaps to track during staging

- Password-reset email has no provider yet: outside development the API logs
  `email_not_sent` and sends nothing. Choose an email provider before launch.
- Rate limits are in-memory per instance (fine for the single disk-backed
  instance).
- Reservation pruning (`npm run inventory:prune-reservations`) stays manual;
  consider a weekly dry run later.

See also `docs/DATABASE_BACKUP_RESTORE.md` and `docs/STAGING_QA.md`.
