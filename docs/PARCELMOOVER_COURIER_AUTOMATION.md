# ParcelMoover courier automation — blocked

Phase 3 was scoped to add real ParcelMoover shipment creation, tracking sync,
webhooks and official labels. Implementation did not start: no authoritative
ParcelMoover API documentation for these actions exists in this repo or was
reachable during the audit, and the project rule is to never guess or
fabricate a provider API. This file exists so a future developer does not
re-guess the same endpoints.

## Confirmed capabilities (in this repo today)

`server/services/parcelmoover.service.js` implements, against
`PARCELMOOVER_BASE_URL` (`https://portal.parcelmoover.com/api/v1`):

| Capability | Path | Method |
| --- | --- | --- |
| List destinations / rate card | `rates` | GET |
| Rate quote | `rates/quote` | GET |
| Health check | `ping` | GET |

All three are Bearer-authenticated, read-only, and used only to price
delivery at checkout (`order.service.js: computeTotals`). Nothing beyond
this is implemented or documented anywhere in the codebase.

## Blocked capabilities — nothing below this line is implemented

Create shipment, retrieve shipment, live tracking, cancel shipment, official
label/barcode/QR, webhook/callback, and the shipment status contract. None of
these have a documented request/response shape, auth requirement, or error
format in this repo.

## Exact information needed from ParcelMoover before continuing

1. Official developer/API documentation (or Postman collection / OpenAPI spec).
2. Create-shipment endpoint: path, method, required/optional fields, response shape.
3. Authentication requirements for shipment-mutating calls (same Bearer key as quoting, or separate credential).
4. Whether sandbox/test credentials or a test-shipment mode exist.
5. Idempotency behavior: does the provider accept a client-supplied reference/idempotency key, and what happens on a duplicate?
6. Tracking endpoint: path, method, response shape, and whether it is pull (lookup) and/or push (webhook).
7. The full shipment status list and its meaning (in-transit, out-for-delivery, delivered, returned, failed, etc.).
8. Cancellation support: is there a cancel-shipment endpoint, and what does it require?
9. Label/barcode/QR support: does the provider return a label PDF/image/URL, or barcode/QR data, and does any URL expire?
10. Webhook support: endpoint registration, signature/secret mechanism, replay protection (event IDs), payload shape.
11. Required parcel weight rules for shipment creation (is weight required, in what unit, what precision).
12. COD field semantics: how COD amount is expressed and settled.
13. Whether `destinationId` from `rates` is the same identifier shipment creation expects, or a different destination reference is required.
14. Rate limits on shipment-mutating and tracking endpoints.

## What must not happen without the above

- No `order_shipment` / shipment table, tracking number column, or shipment
  status enum should be added speculatively.
- No webhook endpoint should be added without a documented signature scheme.
- No barcode/QR/label should be generated and presented as an official
  ParcelMoover artifact.
- `PARCELMOOVER_DEFAULT_WEIGHT_KG` is a pricing input only (used to quote
  delivery charge before an order is placed); it is not a measured parcel
  weight and must never be printed on an invoice or parcel label as one.
- The CaseVerse A4 invoice and A6 parcel label
  (`client/src/pages/admin/PrintOrder.jsx`) are CaseVerse's own documents,
  not ParcelMoover documents, and must keep saying so.

## Once documentation is supplied

Re-run the Phase 3 audit against the confirmed capabilities table above, then
implement only the capabilities the documentation actually describes,
following the existing idempotency (`guest_order_idempotency`) and order
lifecycle locking (`order.service.js: lockOrderLifecycle`) patterns already
in this codebase.
