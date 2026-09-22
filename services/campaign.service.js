'use strict';

/**
 * ONE authoritative definition of the Dashain campaign. Nothing about
 * eligibility or pricing may be decided on the client — every consumer
 * (cart, checkout, order creation, the public banner) reads this window.
 *
 * PLACEHOLDER DATES: `starts_at`/`ends_at` below are a literal fixed
 * 14-day window seeded from today's date, not the real Nepali Dashain
 * calendar date. The store owner must confirm the actual campaign dates
 * and this file must be updated with the real fixed timestamps before
 * the campaign is announced publicly.
 */
const DASHAIN_CAMPAIGN = Object.freeze({
  code: 'DASHAIN_2026',
  name: 'Dashain Trio Offer',
  required_case_quantity: 2,
  bundle_price: 1199,
  free_holder_quantity: 1,
  free_holder_name: 'FREE Suction Phone Holder',
  advance_amount: 100,
  // Fixed, shared window — computed once here, never re-derived from "now".
  starts_at: new Date('2026-09-22T00:00:00+05:45'),
  ends_at: new Date('2026-10-06T00:00:00+05:45'),
});

/** True while `now` falls inside the fixed campaign window. Server-authoritative. */
function isActive(now = new Date()) {
  return now >= DASHAIN_CAMPAIGN.starts_at && now < DASHAIN_CAMPAIGN.ends_at;
}

/** Public, display-safe campaign snapshot for the client (banner/homepage/cart). */
function getCampaign(now = new Date()) {
  return {
    code: DASHAIN_CAMPAIGN.code,
    name: DASHAIN_CAMPAIGN.name,
    active: isActive(now),
    starts_at: DASHAIN_CAMPAIGN.starts_at.toISOString(),
    ends_at: DASHAIN_CAMPAIGN.ends_at.toISOString(),
    required_case_quantity: DASHAIN_CAMPAIGN.required_case_quantity,
    bundle_price: DASHAIN_CAMPAIGN.bundle_price,
    free_holder_quantity: DASHAIN_CAMPAIGN.free_holder_quantity,
    free_holder_name: DASHAIN_CAMPAIGN.free_holder_name,
  };
}

module.exports = { DASHAIN_CAMPAIGN, isActive, getCampaign };
