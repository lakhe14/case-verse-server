'use strict';

const { getCampaign, isActive, DASHAIN_CAMPAIGN } = require('../services/campaign.service');
const { computeCoverBundle, coversRegularPrice } = require('../services/bundle.service');

const inWindow = new Date(DASHAIN_CAMPAIGN.starts_at.getTime() + 1000);
const beforeWindow = new Date(DASHAIN_CAMPAIGN.starts_at.getTime() - 1000);
const afterWindow = DASHAIN_CAMPAIGN.ends_at;

describe('campaign window', () => {
  it('is a fixed 14-day span', () => {
    const days = (DASHAIN_CAMPAIGN.ends_at - DASHAIN_CAMPAIGN.starts_at) / (24 * 60 * 60 * 1000);
    expect(days).toBe(14);
  });

  it('is active inside the window', () => {
    expect(isActive(inWindow)).toBe(true);
  });

  it('is inactive before the window starts', () => {
    expect(isActive(beforeWindow)).toBe(false);
  });

  it('is inactive once the window ends (end is exclusive)', () => {
    expect(isActive(afterWindow)).toBe(false);
  });

  it('getCampaign never leaks a mutable reference', () => {
    const a = getCampaign(inWindow);
    a.bundle_price = 1;
    const b = getCampaign(inWindow);
    expect(b.bundle_price).toBe(1199);
  });
});

describe('Dashain case bundle — campaign inactive', () => {
  const lines = [
    { quantity: 1, category_slug: 'iphone-covers' },
    { quantity: 1, category_slug: 'iphone-covers' },
  ];

  it('two cases price normally: no discount, no free holder', () => {
    const result = computeCoverBundle(lines, beforeWindow);
    expect(result.campaign_active).toBe(false);
    expect(result.pairs).toBe(0);
    expect(result.discount).toBe(0);
    expect(result.free_items).toEqual([]);
    expect(coversRegularPrice(result.covers_qty)).toBe(1398);
  });
});

describe('Dashain case bundle — campaign active', () => {
  it('one case: no bundle, regular price', () => {
    const result = computeCoverBundle([{ quantity: 1, category_slug: 'iphone-covers' }], inWindow);
    expect(result.pairs).toBe(0);
    expect(result.discount).toBe(0);
    expect(result.free_items).toEqual([]);
  });

  it('two cases: 1199 total, 1 free holder', () => {
    const lines = [
      { quantity: 1, category_slug: 'iphone-covers' },
      { quantity: 1, category_slug: 'iphone-covers' },
    ];
    const result = computeCoverBundle(lines, inWindow);
    expect(result.covers_qty).toBe(2);
    expect(result.pairs).toBe(1);
    expect(result.discount).toBe(199); // 1398 - 1199
    expect(result.campaign_code).toBe('DASHAIN_2026');
    expect(result.free_items).toEqual([
      { type: 'suction_holder', name: 'FREE Suction Phone Holder', quantity: 1, price: 0 },
    ]);
  });

  it('three cases: one bundle + one normal case, 1 free holder', () => {
    const result = computeCoverBundle([{ quantity: 3, category_slug: 'iphone-covers' }], inWindow);
    expect(result.pairs).toBe(1);
    expect(result.discount).toBe(199);
    expect(result.free_items[0].quantity).toBe(1);
  });

  it('four cases: two bundles, 2 free holders', () => {
    const result = computeCoverBundle([{ quantity: 4, category_slug: 'iphone-covers' }], inWindow);
    expect(result.pairs).toBe(2);
    expect(result.discount).toBe(398); // 2 * 199
    expect(result.free_items[0].quantity).toBe(2);
  });

  it('non-cover items never count toward eligibility', () => {
    const lines = [
      { quantity: 2, category_slug: 'iphone-covers' },
      { quantity: 5, category_slug: 'ladies-bags' },
    ];
    const result = computeCoverBundle(lines, inWindow);
    expect(result.covers_qty).toBe(2);
    expect(result.pairs).toBe(1);
  });

  it('expires exactly at ends_at: reverts to normal pricing', () => {
    const lines = [
      { quantity: 1, category_slug: 'iphone-covers' },
      { quantity: 1, category_slug: 'iphone-covers' },
    ];
    const result = computeCoverBundle(lines, afterWindow);
    expect(result.campaign_active).toBe(false);
    expect(result.discount).toBe(0);
  });
});
