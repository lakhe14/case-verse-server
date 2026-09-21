'use strict';

const { z, id } = require('./common');

const addItemSchema = z.object({
  variant_id: id,
  quantity: z.coerce.number().int().min(1).max(99),
});

const updateItemSchema = z.object({
  quantity: z.coerce.number().int().min(0).max(99),
});

module.exports = { addItemSchema, updateItemSchema };
