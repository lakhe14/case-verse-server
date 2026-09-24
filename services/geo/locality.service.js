'use strict';

/**
 * Offline locality search and courier-destination suggestion.
 *
 * Everything here runs on the static index in data/geo/locality-index.json
 * (built by scripts/geo/buildLocalityIndex.js) plus the live ParcelMoover
 * destination list. No external service is called, and no search text or
 * position is logged or stored.
 *
 * A place the customer knows (Hadigaun, Sukute) is kept distinct from the
 * courier destination it maps to. A suggestion always points at a destination
 * that exists in the live ParcelMoover list; when no confident mapping exists
 * there is no suggestion and the customer chooses one.
 */

const path = require('path');
const { normalize, normalizeLocalLevel, compact } = require('./normalize');

const INDEX_FILE = path.resolve(__dirname, '..', '..', 'data', 'geo', 'locality-index.json');
const RULES_FILE = path.resolve(__dirname, '..', '..', 'data', 'geo', 'courier-rules.json');

const RESULT_LIMIT = 8;
const NEARBY_KM = 15;
// Within one match tier: well-known and larger places before small ones.
const TYPE_WEIGHT = { x: 0, c: 1, t: 2, s: 3, q: 3, n: 3, v: 4, l: 5, h: 6, r: 7 };
const TYPE_NAMES = { x: 'locality', c: 'city', t: 'town', v: 'village', s: 'suburb', n: 'neighbourhood', q: 'quarter', h: 'hamlet', l: 'locality', r: 'street' };

let loaded = null;

function load() {
  if (loaded) return loaded;
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const raw = require(INDEX_FILE);
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const rules = require(RULES_FILE).municipality_rules;

  const provinces = raw.provinces;
  const districts = raw.districts.map(([name, province, aliases], index) => ({ index, name, province, aliases, norms: [name, ...aliases].map(normalize) }));
  const districtByNorm = new Map();
  for (const district of districts) for (const norm of district.norms) districtByNorm.set(norm, district.index);
  const municipalities = raw.municipalities.map(([name, category, district], index) => ({ index, name, category, district, norm: normalizeLocalLevel(name) }));

  const entries = [];
  for (const district of districts) {
    entries.push({ kind: 'district', name: district.name, norms: district.norms, compact: compact(district.name), district: district.index, muni: -1, weight: 0 });
  }
  for (const muni of municipalities) {
    entries.push({ kind: 'municipality', name: muni.name, norms: [muni.norm, normalize(`${muni.name} ${muni.category}`)], compact: compact(muni.norm), district: muni.district, muni: muni.index, weight: 0 });
  }
  for (const [name, type, district, muni, lat, lon] of raw.places) {
    const norm = normalize(name);
    entries.push({ kind: type === 'r' ? 'street' : 'locality', type, name, norms: [norm], compact: norm.replace(/ /g, ''), district, muni, lat, lon, weight: TYPE_WEIGHT[type] ?? 5 });
  }

  loaded = { provinces, districts, districtByNorm, municipalities, entries, rules };
  return loaded;
}

function districtIndexOf(name) {
  if (!name) return undefined;
  const { districtByNorm } = load();
  const norm = normalize(String(name).replace(/\bdistrict\b/i, ''));
  return districtByNorm.get(norm);
}

function titleCase(value) {
  return String(value).toLowerCase().replace(/_/g, ' ').replace(/\b[a-z]/g, (letter) => letter.toUpperCase()).replace(/\s+/g, ' ').trim();
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// ParcelMoover destinations, parsed once per provider list.

let destinationMemo = { source: null, parsed: null };

/**
 * Destinations are named "LOCALITY - DISTRICT" (e.g. "BASANTAPUR - TERHATHUM",
 * "TOKHA - KTM"). A few have no district part ("IMADOL"); their district is
 * taken from a place of the same name only when that name is unique in Nepal.
 */
function parseDestinations(destinations) {
  if (destinationMemo.source === destinations) return destinationMemo.parsed;
  const { entries, districts } = load();
  const placesByNorm = new Map();
  for (const entry of entries) {
    if (entry.kind !== 'locality') continue;
    const list = placesByNorm.get(entry.norms[0]) || [];
    list.push(entry);
    placesByNorm.set(entry.norms[0], list);
  }
  const parsed = (destinations || []).map((destination) => {
    const raw = String(destination.name || '');
    const split = raw.lastIndexOf(' - ');
    let locality = split > 0 ? raw.slice(0, split) : raw;
    let district = split > 0 ? districtIndexOf(raw.slice(split + 3)) : undefined;
    const localityNorm = normalize(locality);
    const candidates = placesByNorm.get(localityNorm) || [];
    if (district === undefined) {
      const districtsSeen = new Set(candidates.map((place) => place.district));
      if (districtsSeen.size === 1) district = [...districtsSeen][0];
    }
    // Position of the destination's own town, for "nearest destination".
    const place = candidates.filter((item) => item.district === district).sort((a, b) => a.weight - b.weight)[0];
    locality = titleCase(locality);
    const districtName = district === undefined ? null : districts[district].name;
    return {
      id: destination.id,
      name: destination.name,
      label: districtName && normalize(locality) !== normalize(districtName) ? `${locality}, ${districtName}` : locality,
      locality,
      localityNorm,
      localityCompact: localityNorm.replace(/ /g, ''),
      nameNorm: normalize(raw),
      district,
      district_name: districtName,
      lat: place?.lat,
      lon: place?.lon,
    };
  });
  destinationMemo = { source: destinations, parsed };
  return parsed;
}

/** Public, additive fields for GET /shipping/parcelmoover/destinations. */
function describeDestinations(destinations) {
  return parseDestinations(destinations).map(({ id, label, locality, district_name: district }) => ({ id, label, locality, district }));
}

function publicDestination(destination) {
  return { id: destination.id, name: destination.name, label: destination.label, district: destination.district_name };
}

/**
 * Best real destination for a place, or null. Confidence, strongest first:
 *   exact        a destination named after this place in the same district
 *   municipality a destination named after the place's municipality
 *   rule         data/geo/courier-rules.json, if that destination exists
 *   nearby       the nearest destination in the same district within 15 km
 *   district     the only destination in the district
 */
function suggestDestination({ name, district, muni, lat, lon }, parsed) {
  if (district === undefined || district === null) return null;
  const { municipalities, districts, rules } = load();
  const inDistrict = parsed.filter((destination) => destination.district === district);
  if (!inDistrict.length) return null;

  if (name) {
    const norm = normalize(name);
    const packed = norm.replace(/ /g, '');
    const exact = inDistrict.find((destination) => destination.localityNorm === norm || destination.localityCompact === packed);
    if (exact) return { destination: exact, match: 'exact' };
  }
  const municipality = muni >= 0 ? municipalities[muni] : null;
  if (municipality) {
    const byMuni = inDistrict.find((destination) => destination.localityNorm === municipality.norm || destination.localityCompact === municipality.norm.replace(/ /g, ''));
    if (byMuni) return { destination: byMuni, match: 'municipality' };
    const rule = rules.find((item) => normalize(item.district) === normalize(districts[district].name) && normalizeLocalLevel(item.municipality) === municipality.norm);
    const ruled = rule && parsed.find((destination) => destination.name === rule.destination_name);
    if (ruled) return { destination: ruled, match: 'municipality' };
  }
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const nearest = inDistrict
      .filter((destination) => Number.isFinite(destination.lat))
      .map((destination) => ({ destination, km: distanceKm(lat, lon, destination.lat, destination.lon) }))
      .sort((a, b) => a.km - b.km)[0];
    if (nearest && nearest.km <= NEARBY_KM) return { destination: nearest.destination, match: 'nearby' };
  }
  if (inDistrict.length === 1) return { destination: inDistrict[0], match: 'district' };
  return null;
}

function describePlace({ kind, type, name, district, muni }) {
  const { provinces, districts, municipalities } = load();
  const municipality = muni >= 0 ? municipalities[muni] : null;
  const districtRow = district === undefined || district === null ? null : districts[district];
  return {
    kind,
    place_type: type ? TYPE_NAMES[type] : kind,
    name,
    municipality: municipality ? `${municipality.name} ${municipality.category}` : null,
    district: districtRow ? districtRow.name : null,
    province: districtRow ? provinces[districtRow.province] : null,
  };
}

function withSuggestion(place, entry, parsed, suggestion = suggestDestination(entry, parsed)) {
  const count = parsed.filter((destination) => destination.district === entry.district).length;
  return {
    ...place,
    suggested_destination: suggestion ? { ...publicDestination(suggestion.destination), match: suggestion.match } : null,
    district_destination_count: count,
  };
}

// ---------------------------------------------------------------------------
// Search.

// 1 exact locality, 2 exact destination, 3 municipality, 4 district,
// 5 prefix, 6 normalized substring / one-letter typo.
function tierFor(entry, norm, packed) {
  const exact = entry.norms.includes(norm) || entry.compact === packed;
  if (exact) return { locality: 1, street: 1, destination: 2, municipality: 3, district: 4 }[entry.kind];
  if (entry.norms.some((value) => value.startsWith(norm) || value.includes(` ${norm}`)) || entry.compact.startsWith(packed)) return 5;
  if (packed.length >= 4 && entry.compact.includes(packed)) return 6;
  if (packed.length >= 5 && oneEditAway(entry.compact.slice(0, packed.length + 1), packed)) return 6;
  return 0;
}

function oneEditAway(a, b) {
  // True when b is within one insertion, deletion or substitution of a prefix of a.
  if (a.startsWith(b)) return true;
  for (const candidate of [a.slice(0, b.length), a.slice(0, b.length - 1), a.slice(0, b.length + 1)]) {
    if (Math.abs(candidate.length - b.length) > 1) continue;
    let i = 0; let j = 0; let edits = 0;
    while (i < candidate.length && j < b.length) {
      if (candidate[i] === b[j]) { i += 1; j += 1; continue; }
      edits += 1;
      if (edits > 1) break;
      if (candidate.length > b.length) i += 1;
      else if (candidate.length < b.length) j += 1;
      else { i += 1; j += 1; }
    }
    edits += (candidate.length - i) + (b.length - j);
    if (edits <= 1) return true;
  }
  return false;
}

/**
 * Ranked places and destinations for free text. Returns at most 8 results;
 * destinations stay visible even when many same-named villages exist.
 */
function search(query, destinations) {
  const norm = normalize(query);
  const packed = norm.replace(/ /g, '');
  if (packed.length < 2) return [];
  const { entries } = load();
  const parsed = parseDestinations(destinations);

  const scored = [];
  for (const entry of entries) {
    const tier = tierFor(entry, norm, packed);
    if (tier) scored.push({ entry, tier });
  }
  for (const destination of parsed) {
    const entry = { kind: 'destination', name: destination.label, norms: [destination.localityNorm, destination.nameNorm], compact: destination.localityCompact, district: destination.district, weight: 0, destination };
    const tier = tierFor(entry, norm, packed);
    if (tier) scored.push({ entry, tier });
  }
  // Within a tier, places that map to a real destination come first
  // (strongest mapping first), so "Basantapur, Terhathum" (a destination town)
  // is not buried under hamlets of the same name. Only exact-name matches are
  // few enough to check here.
  const MATCH_RANK = { exact: 0, municipality: 1, nearby: 2, district: 3 };
  for (const item of scored) {
    if (item.tier <= 4 && item.entry.kind !== 'destination' && item.entry.kind !== 'district') {
      item.suggestion = suggestDestination(item.entry, parsed);
      item.mapping = item.suggestion ? MATCH_RANK[item.suggestion.match] : 4;
    } else {
      item.mapping = 4;
    }
  }
  scored.sort((a, b) => a.tier - b.tier || a.entry.weight - b.entry.weight || a.mapping - b.mapping || a.entry.name.length - b.entry.name.length || a.entry.name.localeCompare(b.entry.name));

  const results = [];
  const seen = new Set();
  const quota = { locality: 5, street: 2, municipality: 3, district: 2, destination: 4 };
  const take = (item) => {
    const { entry } = item;
    const key = entry.kind === 'destination' ? `d:${entry.destination.id}` : `${entry.kind === 'street' ? 's' : 'p'}:${normalize(entry.name)}:${entry.district}:${entry.muni}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(item);
  };
  for (const item of scored) {
    if (results.length >= RESULT_LIMIT) break;
    const used = results.filter((result) => result.entry.kind === item.entry.kind).length;
    if (used < quota[item.entry.kind]) take(item);
  }
  // Fill any remaining room ignoring the per-kind quotas.
  for (const item of scored) {
    if (results.length >= RESULT_LIMIT) break;
    take(item);
  }

  return results.map(({ entry, suggestion }) => {
    if (entry.kind === 'destination') {
      const place = describePlace({ kind: 'destination', name: entry.destination.label, district: entry.district, muni: -1 });
      return { ...place, suggested_destination: { ...publicDestination(entry.destination), match: 'destination' }, district_destination_count: parsed.filter((item) => item.district === entry.district).length };
    }
    return withSuggestion(describePlace(entry), entry, parsed, suggestion === undefined ? suggestDestination(entry, parsed) : suggestion);
  });
}

// ---------------------------------------------------------------------------
// Reverse-geocoded address -> official names + suggestion.

/**
 * Normalizes a provider address (district, municipality and locality names
 * as OSM spells them) onto the official lists, and suggests a destination.
 * Anything that cannot be matched is passed through as the provider wrote it,
 * or left empty; the customer reviews and edits every field.
 */
function resolveAddress({ district: districtName, municipality: muniName, locality, street, lat, lon }, destinations) {
  const { provinces, districts, municipalities, entries } = load();
  const district = districtIndexOf(districtName);
  let muni = -1;
  if (district !== undefined && muniName) {
    const target = normalizeLocalLevel(muniName);
    muni = municipalities.findIndex((item) => item.district === district && (item.norm === target || item.norm.replace(/ /g, '') === target.replace(/ /g, '')));
  }
  // A well-known locality from the index near this position (for example the
  // "Basantapur" supplement row), so the suggestion uses the same mapping as search.
  let localityName = locality || null;
  if (localityName && district !== undefined) {
    const norm = normalize(localityName);
    const known = entries.find((entry) => entry.kind === 'locality' && entry.district === district && entry.norms[0] === norm);
    if (known && muni < 0) muni = known.muni;
  }
  const parsed = parseDestinations(destinations);
  const suggestion = district === undefined ? null : suggestDestination({ name: localityName || street, district, muni, lat, lon }, parsed);
  const municipality = muni >= 0 ? municipalities[muni] : null;
  return {
    province: district === undefined ? null : provinces[districts[district].province],
    district: district === undefined ? (districtName || null) : districts[district].name,
    municipality: municipality ? `${municipality.name} ${municipality.category}` : (muniName || null),
    locality: localityName,
    street: street || null,
    suggested_destination: suggestion ? { ...publicDestination(suggestion.destination), match: suggestion.match } : null,
  };
}

module.exports = { search, resolveAddress, describeDestinations, suggestDestination, parseDestinations, districtIndexOf, normalize };
