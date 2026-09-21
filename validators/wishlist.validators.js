'use strict';

const { z, id } = require('./common');

const addWishlistSchema = z.object({ product_id: id });
const productIdParam = z.object({ productId: id });

module.exports = { addWishlistSchema, productIdParam };
