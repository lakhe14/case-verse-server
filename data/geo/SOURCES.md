# Geographic data: sources and licences

This folder holds the offline data behind checkout's place search
(`POST /api/geo/localities/search`) and the courier-destination suggestion
after "Use my location" (`POST /api/geo/reverse`). The API reads these files
at runtime and never calls the sources below.

| File | What it is | Source | Licence |
| --- | --- | --- | --- |
| `locality-index.json` | Generated compact index (do not edit by hand) | Both sources below, combined by `scripts/geo/buildLocalityIndex.js` | Provinces/districts/local levels: MIT. Places and streets: ODbL 1.0 |
| `supplement-localities.json` | Hand-maintained list of OSM feature ids for well-known names OSM records only as a street or landmark | OpenStreetMap feature ids | ODbL 1.0 (positions and boundaries come from OSM) |
| `courier-rules.json` | Hand-maintained CaseVerse courier knowledge (local level to ParcelMoover destination name) | CaseVerse | Project licence |
| `LICENSE-local-states-nepal.txt` | Licence text for the local-levels dataset | sagautam5/local-states-nepal | MIT |

## 1. Provinces, districts and local levels

- Dataset: <https://github.com/sagautam5/local-states-nepal>, files
  `dataset/{provinces,districts,municipalities,categories}/en.json`.
- Pinned commit: `035cb3d2ce2420ad04d7aac1d0ce4d08960c57f0` (2026-03-22).
- Licence: MIT, copyright (c) 2020 Sagar Gautam. The full text is in
  `LICENSE-local-states-nepal.txt` and must stay with the derived data.
- In the index: the `provinces`, `districts` and `municipalities` arrays.
  Four district spellings are changed for display (Achham, Panchthar, Parbat,
  Ramechhap; Eastern/Western Rukum shown as Rukum East/West) and aliases are
  added so ParcelMoover ("KTM", "Nawalparasi East") and OSM spellings resolve.

## 2. OpenStreetMap places and streets

- Data © OpenStreetMap contributors, available under the Open Database
  License 1.0: <https://www.openstreetmap.org/copyright>,
  <https://opendatacommons.org/licenses/odbl/1-0/>.
- Retrieved with the Overpass API (<https://overpass-api.de>) by
  `scripts/geo/buildLocalityIndex.js`. The build date is `generated_at` in the
  index.
- Included: nodes, ways and relations tagged `place=city|town|village|suburb|
  neighbourhood|quarter|hamlet|locality`, and ways tagged
  `highway=trunk|primary|secondary|tertiary|unclassified|residential|living_street`,
  each with a Latin-script name. District and municipality come from the OSM
  administrative boundaries (admin_level 6 and 7) that contain the feature.
- In the index: the `places` array, as `[name, type, district index,
  municipality index or -1, latitude, longitude]` with positions rounded to
  4 decimals.
- The index is a derivative database under ODbL. If it is shared outside
  CaseVerse it must be offered under ODbL with this attribution.

### Attribution shown to customers

- Checkout, next to place-search results and next to an address filled in
  from "Use my location": "© OpenStreetMap contributors", linking to
  <https://www.openstreetmap.org/copyright>.
- Privacy policy page: "Place and address data" item.

## 3. Reverse geocoding (runtime, not stored here)

"Use my location" asks a Nominatim-compatible API through our server
(`services/geo/reverseGeocode.service.js`). The default is the public
OpenStreetMap Nominatim instance, subject to its usage policy
(<https://operations.osmfoundation.org/policies/nominatim/>): at most one
request per second, an identifying User-Agent, no autocomplete, attribution.
Configure it with `GEOCODER_BASE_URL`, `GEOCODER_API_KEY`, `GEOCODER_CONTACT`
and `GEOCODER_REFERER`.

## Rebuilding

```
node scripts/geo/buildLocalityIndex.js
```

Raw downloads are cached in `.cache/geo/` (git-ignored); delete that folder to
fetch fresh data. The script prints any OSM district or municipality name it
could not match to the official list; those places keep their district but
have no municipality.
