'use strict';

/**
 * "Buy 2 covers for 1199" bundle pricing.
 *
 * iPhone Covers are 699 each, but any 2 covers together cost 1199. The rule is
 * based on the TOTAL quantity of iPhone-Covers-category items in the cart, not on
 * any specific product — mixing designs and models is fine.
 *
 *   qty 1 -> 699
 *   qty 2 -> 1199
 *   qty 3 -> 1199 + 699
 *   qty 4 -> 1199 + 1199
 *   price(qty) = floor(qty / 2) * 1199 + (qty % 2) * 699
 *
 * The saving is `qty * 699 - price(qty)`, i.e. 199 per completed pair.
 */

const COVER_CATEGORY_SLUG = 'iphone-covers';
const COVER_UNIT_PRICE = 699;
const COVER_PAIR_PRICE = 1199;

/** Regular (undiscounted) price for `qty` covers. */
function coversRegularPrice(qty) {
  return qty * COVER_UNIT_PRICE;
}

/** Bundle price for `qty` covers. */
function coversBundlePrice(qty) {
  return Math.floor(qty / 2) * COVER_PAIR_PRICE + (qty % 2) * COVER_UNIT_PRICE;
}

/**
 * Given line objects, work out the cover bundle discount.
 *
 * @param {Array} lines - each item must expose a quantity and a way to tell
 *   whether it is an iPhone Covers item. Accepts either
 *   `{ quantity, category_slug }` or `{ quantity, is_cover }`.
 * @returns {{ covers_qty: number, pairs: number, discount: number }}
 */
function computeCoverBundle(lines) {
  const coversQty = lines.reduce((sum, l) => {
    const isCover = l.is_cover ?? l.category_slug === COVER_CATEGORY_SLUG;
    return isCover ? sum + Number(l.quantity || 0) : sum;
  }, 0);

  const discount = Number(
    (coversRegularPrice(coversQty) - coversBundlePrice(coversQty)).toFixed(2)
  );

  return { covers_qty: coversQty, pairs: Math.floor(coversQty / 2), discount };
}

module.exports = {
  COVER_CATEGORY_SLUG,
  COVER_UNIT_PRICE,
  COVER_PAIR_PRICE,
  coversRegularPrice,
  coversBundlePrice,
  computeCoverBundle,
};
