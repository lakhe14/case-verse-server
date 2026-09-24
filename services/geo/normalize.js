'use strict';

/**
 * Text normalization shared by the locality index build and the runtime
 * search, so both sides agree on what counts as "the same name".
 */

// Common romanization variants of Nepali place-name parts, folded to one form.
const TOKEN_VARIANTS = new Map([
  ['gaon', 'gaun'],
  ['chok', 'chowk'], ['chauk', 'chowk'],
  ['bazaar', 'bazar'], ['bajar', 'bazar'],
  ['tole', 'tol'],
  ['marga', 'marg'],
  ['nagr', 'nagar'],
  ['ktm', 'kathmandu'],
]);

// Words that describe a local level's category rather than name it.
const CATEGORY_WORDS = new Set(['metropolitan', 'sub', 'city', 'municipality', 'rural', 'gaunpalika', 'nagarpalika', 'mahanagarpalika', 'upamahanagarpalika', 'mun', 'rm', 'vdc']);

function normalize(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => TOKEN_VARIANTS.get(token) || token)
    .join(' ');
}

/** Name with category words ("Metropolitan City", "Rural Municipality") removed. */
function normalizeLocalLevel(value) {
  return normalize(value).split(' ').filter((token) => !CATEGORY_WORDS.has(token)).join(' ');
}

/** Spaces removed as well, so "Basanta Pur" and "Basantapur" compare equal. */
function compact(value) {
  return normalize(value).replace(/ /g, '');
}

/** True when the value contains at least one Latin letter (skips Devanagari-only names). */
function hasLatin(value) {
  return /[A-Za-z]/.test(String(value ?? ''));
}

module.exports = { normalize, normalizeLocalLevel, compact, hasLatin };
