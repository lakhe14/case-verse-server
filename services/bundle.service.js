'use strict';

/**
 * Dashain campaign case-bundle pricing.
 *
 * This used to be a permanent, always-on "buy 2 covers for 1199" store
 * policy. That is gone: bundle pricing now applies ONLY while the Dashain
 * campaign (campaign.service.js) is active. Outside the campaign window,
 * iPhone Covers price normally (699 each) with no bundle math at all.
 *
 * While active, each complete pair of eligible iPhone-Covers-category items
 * costs the campaign bundle price and earns one free suction holder:
 *
 *   qty 1 -> 699
 *   qty 2 -> 1199 (+ 1 free holder)
 *   qty 3 -> 1199 + 699 (+ 1 free holder)
 *   qty 4 -> 1199 + 1199 (+ 2 free holders)
 *   price(qty) = floor(qty / 2) * bundle_price + (qty % 2) * unit_price
 *
 * This is the ONE authoritative pricing path — there is no separate
 * "permanent" fallback bundle calculation left anywhere in the codebase.
 */

const { getCampaign } = require('./campaign.service');

const COVER_CATEGORY_SLUG = 'iphone-covers';
const COVER_UNIT_PRICE = 699;

/** Regular (undiscounted) price for `qty` covers — independent of the campaign. */
function coversRegularPrice(qty) {
  return qty * COVER_UNIT_PRICE;
}

/** Campaign bundle price for `qty` covers, given the campaign's bundle price. */
function coversBundlePrice(qty, bundlePrice) {
  return Math.floor(qty / 2) * bundlePrice + (qty % 2) * COVER_UNIT_PRICE;
}

/**
 * Given cart/order line objects, work out the Dashain bundle discount and
 * free-item entitlement. Reads the campaign's active state itself — callers
 * never pass in "is the campaign active" from client input.
 *
 * @param {Array} lines - each item must expose `quantity` and either
 *   `category_slug` or `is_cover` to identify iPhone Covers items.
 * @param {Date} [now] - injectable for tests; defaults to the real clock.
 */
function computeCoverBundle(lines, now = new Date()) {
  const campaign = getCampaign(now);

  const coversQty = lines.reduce((sum, l) => {
    const isCover = l.is_cover ?? l.category_slug === COVER_CATEGORY_SLUG;
    return isCover ? sum + Number(l.quantity || 0) : sum;
  }, 0);

  if (!campaign.active) {
    return {
      covers_qty: coversQty,
      pairs: 0,
      discount: 0,
      campaign_active: false,
      campaign_code: null,
      campaign_label: null,
      free_items: [],
    };
  }

  const pairs = Math.floor(coversQty / 2);
  const discount = Number(
    (coversRegularPrice(coversQty) - coversBundlePrice(coversQty, campaign.bundle_price)).toFixed(2)
  );

  const freeItems =
    pairs > 0
      ? [
          {
            type: 'suction_holder',
            name: campaign.free_holder_name,
            quantity: pairs * campaign.free_holder_quantity,
            price: 0,
          },
        ]
      : [];

  return {
    covers_qty: coversQty,
    pairs,
    discount,
    campaign_active: true,
    campaign_code: campaign.code,
    campaign_label: campaign.name,
    free_items: freeItems,
  };
}

module.exports = {
  COVER_CATEGORY_SLUG,
  COVER_UNIT_PRICE,
  coversRegularPrice,
  coversBundlePrice,
  computeCoverBundle,
};
