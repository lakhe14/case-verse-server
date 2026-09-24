# CaseVerse staging QA checklist

Run against the deployed staging stack (Vercel storefront, Render API + cron,
managed MySQL, Render disk). Mark each item PASS / FAIL with the date and who
checked it. Every item must PASS before production is created. Use test
customers, small real payments only where the item says so, and never real
customer data.

| # | Check | How | Result |
| --- | --- | --- | --- |
| 1 | Deployed frontend loads | open the Vercel URL; home, `/covers`, a PDP render | |
| 2 | API health | `GET https://<api>/api/health` → 200 `{"status":"ok","database":"ok"}` | |
| 3 | HTTPS | both hosts redirect/serve https only; no mixed content in the console | |
| 4 | CORS | storefront calls succeed; a request with another `Origin` gets no `Access-Control-Allow-Origin` | |
| 5 | MySQL connection | health `database: ok`; Render logs show no `database_connect_failed` | |
| 6 | Admin bootstrap | `npm run staff:bootstrap-admin` once; Super Admin can sign in at `/admin`; bootstrap variables removed afterwards | |
| 7 | ParcelMoover destinations | checkout destination list loads from the deployed API | |
| 8 | ParcelMoover live quote | choosing a destination shows a real shipping price | |
| 9 | Customer registration | new account created | |
| 10 | Customer login | sign in / out; refresh keeps the session | |
| 11 | Guest checkout | place a guest order; guest order page opens from its link | |
| 12 | Signed-in checkout | place an order from the cart | |
| 13 | Inventory reservation | after placing, public stock for that variant drops by the quantity | |
| 14 | Physical stock unchanged before payment | admin inventory: Physical same, Reserved up, Available down | |
| 15 | NPR 100 advance | order page shows NPR 100 eSewa advance, QR visible | |
| 16 | Payment proof upload | JPG/PNG/WebP ≤ 5 MB accepted; other files refused | |
| 17 | Proof survives backend redeploy | redeploy the API; staff can still open the proof | |
| 18 | Authorized staff proof preview | payment staff open "View proof" | |
| 19 | Unauthorized proof access denied | signed-out, customer, and staff without payment permission get 401/403; `/uploads/<proof file>` is 404 | |
| 20 | Approve commits stock once | approve: Physical −qty once; approving again is refused | |
| 21 | Reject / re-upload | reject with a note; customer sees it, uploads again within the retry window | |
| 22 | COD request | "Request COD confirmation" sets COD pending | |
| 23 | WhatsApp does NOT confirm COD | opening WhatsApp alone leaves the order pending | |
| 24 | Staff COD confirmation | staff confirm COD → processing, stock committed once | |
| 25 | Cancellation / release / restock | cancel unpaid → hold released; cancel paid (staff) → stock restocked once | |
| 26 | Coupon use | single cover + valid coupon discounted; usage limit respected | |
| 27 | Dashain bundle pricing | 2 covers → 1199 + free holder; 3 → 1199 + 699; 4 → 2 × 1199 (while the campaign runs) | |
| 28 | Coupon / Dashain stacking | coupon field hidden with a bundle, back for a single cover | |
| 29 | Stale-order cron | Render cron runs every 15 min; an expired unpaid test order becomes cancelled (payment timeout); logs show counts only | |
| 30 | Payment proof overdue | a proof older than 72 h shows "Review overdue" to staff, stays pending, stock still held | |
| 31 | Admin permissions | Product Manager cannot review payments; Order Manager cannot edit products | |
| 32 | Admin inventory guard | setting physical stock below reserved is refused | |
| 33 | Mobile 390 px | home, PDP, cart, checkout, order page, admin queue: no sideways scroll | |
| 34 | Mobile 430 px | same | |
| 35 | Tablet 768 px | same | |
| 36 | Desktop 1366 px | same | |
| 37 | Console errors | browser console clean on the flows above | |
| 38 | API / server errors | Render logs: no 5xx during QA; any error line is structured JSON without SQL, customer data or tokens | |
| 39 | Restart / redeploy persistence | after redeploy: orders, proofs, product images and sessions still work | |
| 40 | DB backup | provider automated backup visible; one `mysqldump` taken per `DATABASE_BACKUP_RESTORE.md` | |
| 41 | Restore drill | that backup restored into a NEW database and verified (tables, counts, latest migration) | |

Record anything outside the checklist (slow pages, copy, layout) as notes
below; they do not block staging sign-off unless they affect payment, stock or
privacy.

## Notes

- (none yet)
