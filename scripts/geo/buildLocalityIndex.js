'use strict';

/**
 * Builds data/geo/locality-index.json, the offline index behind
 * POST /api/geo/localities/search and the address suggestion after
 * "Use my location".
 *
 *   node scripts/geo/buildLocalityIndex.js
 *
 * Development-time only. It downloads two sources, keeps the raw downloads in
 * .cache/geo/ (git-ignored) and writes one compact JSON file that the API
 * reads at runtime. The API never calls these sources itself.
 *
 *   1. Nepal's 7 provinces, 77 districts and 753 local levels from
 *      sagautam5/local-states-nepal (MIT), pinned to one commit.
 *   2. Named places (city, town, village, suburb, neighbourhood, quarter,
 *      hamlet, locality) and named streets from OpenStreetMap via the
 *      Overpass API (ODbL 1.0), with each one's district and municipality
 *      taken from the OSM administrative boundaries.
 *
 * data/geo/supplement-localities.json adds a few customer-familiar names that
 * OSM records only as a street or landmark; they are resolved to their OSM
 * feature here, never to a hand-written district.
 *
 * See data/geo/SOURCES.md for licences and attribution.
 */

const fs = require('fs');
const path = require('path');
const { normalize, normalizeLocalLevel, hasLatin } = require('../../services/geo/normalize');

const LOCAL_LEVELS_COMMIT = '035cb3d2ce2420ad04d7aac1d0ce4d08960c57f0';
const LOCAL_LEVELS_BASE = `https://raw.githubusercontent.com/sagautam5/local-states-nepal/${LOCAL_LEVELS_COMMIT}/dataset`;
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'CaseVerse locality index build (https://github.com/lakhe14)';

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'geo');
const OUT_FILE = path.join(ROOT, 'data', 'geo', 'locality-index.json');
const SUPPLEMENT_FILE = path.join(ROOT, 'data', 'geo', 'supplement-localities.json');

const PLACE_TYPES = ['city', 'town', 'village', 'suburb', 'neighbourhood', 'quarter', 'hamlet', 'locality'];
const STREET_TYPES = ['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street'];
const TYPE_CODES = { city: 'c', town: 't', village: 'v', suburb: 's', neighbourhood: 'n', quarter: 'q', hamlet: 'h', locality: 'l', street: 'r', supplement: 'x' };

// Display names for districts whose dataset spelling differs from common use,
// plus every spelling seen in ParcelMoover destination names and OSM/Nominatim.
const DISTRICT_OVERRIDES = {
  Acham: { name: 'Achham' },
  Pachthar: { name: 'Panchthar' },
  Parwat: { name: 'Parbat' },
  Ramechap: { name: 'Ramechhap' },
  Nawalpur: { aliases: ['Nawalparasi East', 'Nawalparasi (Bardaghat Susta East)', 'Nawalparasi Bardaghat Susta East'] },
  Parasi: { aliases: ['Nawalparasi West', 'Nawalparasi W', 'Nawalparasi (Bardaghat Susta West)', 'Nawalparasi Bardaghat Susta West'] },
  'Eastern Rukum': { name: 'Rukum East', aliases: ['Eastern Rukum', 'Rukum Purba'] },
  'Western Rukum': { name: 'Rukum West', aliases: ['Western Rukum', 'Rukum Paschim'] },
  Kapilvastu: { aliases: ['Kapilbastu'] },
  Tanahun: { aliases: ['Tanahu'] },
  Kathmandu: { aliases: ['KTM'] },
  Kavrepalanchok: { aliases: ['Kavre', 'Kabhrepalanchok', 'Kabhrepalanchowk'] },
  Terhathum: { aliases: ['Tehrathum'] },
  Sindhupalchok: { aliases: ['Sindhupalchowk'] },
  Makwanpur: { aliases: ['Makawanpur'] },
  Dhanusha: { aliases: ['Dhanusa'] },
  Chitwan: { aliases: ['Chitawan'] },
  Udayapur: { aliases: ['Udaypur'] },
  Sankhuwasabha: { aliases: ['Sankhuwasava'] },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Romanizations of one Nepali name differ (Balefi/Balephi, Barhabise/Bahrabise,
// Sworgadwary/Swargadwari): fold aspirates and common vowel spellings before
// comparing names of local levels inside one district.
function phonetic(value) {
  return normalizeLocalLevel(value).replace(/ /g, '')
    .replace(/chh/g, 'ch').replace(/([bdgjkpt])h/g, '$1').replace(/sh/g, 's').replace(/ph/g, 'f')
    .replace(/[vw]/g, 'b').replace(/y/g, 'i').replace(/aa/g, 'a').replace(/ee/g, 'i').replace(/oo/g, 'u');
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/** Strips "District", "(Nepal)" and similar decorations from an OSM district name. */
const cleanDistrictName = (value) => String(value || '').replace(/\(.*?\)/g, ' ').replace(/\bdistrict\b/gi, ' ').trim();

async function cached(name, load) {
  const file = path.join(CACHE_DIR, name);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const data = await load();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

async function getJson(url, init) {
  const response = await fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, ...(init?.headers || {}) } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

async function overpass(name, query) {
  return cached(`${name}.json`, async () => {
    console.log(`Overpass: ${name}…`);
    let data;
    for (let attempt = 1; !data; attempt += 1) {
      try {
        data = await getJson(OVERPASS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: query }).toString(),
        });
      } catch (error) {
        // The shared instance answers 429/504 when busy: wait and retry a few times.
        if (attempt >= 4) throw error;
        console.log(`  ${error.message}; retrying in ${attempt * 20} s`);
        await sleep(attempt * 20000);
      }
    }
    await sleep(5000); // be gentle with the shared Overpass instance
    return data;
  });
}

const NEPAL = 'area["ISO3166-1"="NP"][admin_level=2]->.np;';
const TARGETS = (area) => `(nwr(${area})[place~"^(${PLACE_TYPES.join('|')})$"][name];way(${area})[highway~"^(${STREET_TYPES.join('|')})$"][name];)`;

/** Splits foreach output into { areaName: [elementKey, ...] } using the area markers. */
function groupByArea(elements) {
  const groups = [];
  let current = null;
  for (const element of elements) {
    if (element.type === 'area') {
      current = { tags: element.tags || {}, members: [] };
      groups.push(current);
    } else if (current) {
      current.members.push(`${element.type}/${element.id}`);
    }
  }
  return groups;
}

function latinName(tags = {}) {
  if (hasLatin(tags['name:en'])) return tags['name:en'].trim();
  if (hasLatin(tags.name)) return tags.name.trim();
  return null;
}

function point(element) {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return [Number(lat.toFixed(4)), Number(lon.toFixed(4))];
}

async function main() {
  // 1. Official local levels.
  const [provinces, districts, municipalities, categories] = await Promise.all(
    ['provinces', 'districts', 'municipalities', 'categories'].map((name) => cached(`local-levels-${name}.json`, () => getJson(`${LOCAL_LEVELS_BASE}/${name}/en.json`)))
  );
  const provinceIndex = new Map(provinces.map((province, index) => [province.id, index]));
  const districtList = districts.map((district) => {
    const override = DISTRICT_OVERRIDES[district.name] || {};
    const name = override.name || district.name;
    const aliases = [...new Set([district.name, ...(override.aliases || [])].filter((alias) => alias !== name))];
    return { id: district.id, name, province: provinceIndex.get(district.province_id), aliases };
  });
  const districtIndexById = new Map(districtList.map((district, index) => [district.id, index]));
  const districtByNorm = new Map();
  districtList.forEach((district, index) => {
    for (const alias of [district.name, ...district.aliases]) districtByNorm.set(normalize(alias), index);
  });
  const categoryById = new Map(categories.map((category) => [category.id, category.name]));
  const muniList = municipalities.map((muni) => ({ name: muni.name, category: categoryById.get(muni.category_id), district: districtIndexById.get(muni.district_id) }));

  // 2. OpenStreetMap features and the boundaries that contain them.
  const features = await overpass('osm-features', `[out:json][timeout:900];${NEPAL}${TARGETS('area.np')};out center tags qt;`);
  const districtAreas = await overpass('osm-district-members', `[out:json][timeout:1200];${NEPAL}rel(area.np)[boundary=administrative][admin_level=6];map_to_area->.districts;foreach.districts->.d(.d out tags;${TARGETS('area.d')};out ids qt;);`);
  const muniAreas = await overpass('osm-municipality-members', `[out:json][timeout:1800];${NEPAL}rel(area.np)[boundary=administrative][admin_level=7];map_to_area->.munis;foreach.munis->.m(.m out tags;${TARGETS('area.m')};out ids qt;);`);

  const supplement = JSON.parse(fs.readFileSync(SUPPLEMENT_FILE, 'utf8')).localities;
  const supplementQuery = supplement.map((entry) => { const [type, id] = entry.osm.split('/'); return `${type === 'relation' ? 'rel' : type}(${id});`; }).join('');
  const supplementFeatures = await overpass('osm-supplement', `[out:json][timeout:120];(${supplementQuery});out center tags;`);

  // District of each OSM element (first district that contains it).
  const unknownDistricts = new Set();
  const elementDistrict = new Map();
  for (const group of groupByArea(districtAreas.elements)) {
    const name = cleanDistrictName(group.tags['name:en'] || group.tags.name);
    const index = districtByNorm.get(normalize(name));
    if (index === undefined) { unknownDistricts.add(name); continue; }
    for (const key of group.members) if (!elementDistrict.has(key)) elementDistrict.set(key, index);
  }

  const matchMuni = (osmName, district) => {
    const target = normalizeLocalLevel(osmName);
    if (!target || district === undefined) return -1;
    const exact = muniList.findIndex((m) => m.district === district && normalizeLocalLevel(m.name) === target);
    if (exact >= 0) return exact;
    const packed = muniList.findIndex((m) => m.district === district && normalizeLocalLevel(m.name).replace(/ /g, '') === target.replace(/ /g, ''));
    if (packed >= 0) return packed;
    // Spelling variants: the unique closest name in the same district, if close enough.
    const sound = phonetic(osmName);
    const candidates = muniList
      .map((m, index) => ({ index, distance: m.district === district ? editDistance(phonetic(m.name), sound) : Infinity }))
      .filter((item) => item.distance <= (sound.length >= 8 ? 2 : 1))
      .sort((a, b) => a.distance - b.distance);
    if (candidates.length && (candidates.length === 1 || candidates[1].distance > candidates[0].distance)) return candidates[0].index;
    return -1;
  };

  // Municipality of each OSM element, matched to the official list by name
  // within the district most of its members fall in.
  const unmatchedMunis = [];
  const elementMuni = new Map();
  for (const group of groupByArea(muniAreas.elements)) {
    const votes = new Map();
    for (const key of group.members) {
      const district = elementDistrict.get(key);
      if (district !== undefined) votes.set(district, (votes.get(district) || 0) + 1);
    }
    const district = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
    const osmName = group.tags['name:en'] || group.tags.name || '';
    const muni = matchMuni(osmName, district);
    if (muni < 0) { unmatchedMunis.push(`${osmName} (${district === undefined ? '?' : districtList[district].name})`); continue; }
    for (const key of group.members) if (!elementMuni.has(key)) elementMuni.set(key, muni);
  }

  // 3. Compact place rows: [name, type, district, municipality|-1, lat, lon].
  const places = [];
  const seen = new Set();
  let skippedNoDistrict = 0;
  const addPlace = (name, type, key, position, districtOverride) => {
    const district = districtOverride ?? elementDistrict.get(key);
    if (district === undefined || !position) { skippedNoDistrict += 1; return; }
    const muni = elementMuni.get(key) ?? -1;
    // One row per name, type and municipality: long streets are split into many ways.
    const dedupe = `${normalize(name)}|${type === 'r' ? 'r' : 'p'}|${district}|${muni}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    places.push([name, type, district, muni, position[0], position[1]]);
  };
  for (const element of features.elements) {
    const name = latinName(element.tags);
    if (!name) continue;
    const kind = element.tags.place || 'street';
    addPlace(name, TYPE_CODES[kind] || 'l', `${element.type}/${element.id}`, point(element));
  }
  const supplementByKey = new Map(supplementFeatures.elements.map((element) => [`${element.type}/${element.id}`, element]));
  for (const entry of supplement) {
    const element = supplementByKey.get(entry.osm);
    if (!element) throw new Error(`Supplement feature ${entry.osm} (${entry.osm_name}) was not found in OSM`);
    if (element.tags?.name !== entry.osm_name) throw new Error(`Supplement feature ${entry.osm} is now named "${element.tags?.name}", expected "${entry.osm_name}"`);
    // Supplement features are landmarks or streets outside the boundary
    // queries above, so ask OSM which district and municipality contain them.
    const [type, id] = entry.osm.split('/');
    const position = point(element);
    const areas = await overpass(`osm-supplement-areas-${type}-${id}`, `[out:json][timeout:120];is_in(${position[0]},${position[1]});area._[boundary=administrative][admin_level~"^(6|7)$"];out tags;`);
    const areaName = (level) => { const area = areas.elements.find((item) => item.tags?.admin_level === level); return area ? (area.tags['name:en'] || area.tags.name) : null; };
    const district = districtByNorm.get(normalize(cleanDistrictName(areaName('6'))));
    if (district === undefined) throw new Error(`Supplement feature ${entry.osm} is not inside a known OSM district`);
    const muni = matchMuni(areaName('7'), district);
    const dedupe = `${normalize(entry.name)}|p|${district}|${muni}`;
    if (!seen.has(dedupe)) { seen.add(dedupe); places.push([entry.name, 'x', district, muni, position[0], position[1]]); }
  }

  const index = {
    version: 1,
    generated_at: new Date().toISOString(),
    sources: {
      local_levels: { name: 'sagautam5/local-states-nepal', commit: LOCAL_LEVELS_COMMIT, license: 'MIT' },
      places: { name: 'OpenStreetMap via Overpass API', license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors' },
    },
    types: Object.fromEntries(Object.entries(TYPE_CODES).map(([name, code]) => [code, name])),
    provinces: provinces.map((province) => province.name),
    districts: districtList.map((district) => [district.name, district.province, district.aliases]),
    municipalities: muniList.map((muni) => [muni.name, muni.category, muni.district]),
    places,
  };
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(index)}\n`);

  const counts = places.reduce((acc, row) => { acc[index.types[row[1]]] = (acc[index.types[row[1]]] || 0) + 1; return acc; }, {});
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)} KB)`);
  console.log(`  ${districtList.length} districts, ${muniList.length} local levels, ${places.length} places`, counts);
  console.log(`  ${places.filter((row) => row[3] < 0).length} places without a matched municipality; ${skippedNoDistrict} features outside any district skipped`);
  if (unknownDistricts.size) console.log('  NEEDS REVIEW: OSM districts not matched to the official list:', [...unknownDistricts].join(', '));
  if (unmatchedMunis.length) console.log(`  NEEDS REVIEW: ${unmatchedMunis.length} OSM municipalities not matched to the official list:`, unmatchedMunis.join('; '));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
