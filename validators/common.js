'use strict';

const { z } = require('zod');

const email = z.string().trim().toLowerCase().email().max(190);
const password = z.string().min(8).max(128);
const shortText = (max) => z.string().trim().min(1).max(max);
const id = z.coerce.number().int().positive();
// Nepal-friendly: an optional +977/0 prefix, then a 9xxxxxxxxx mobile number.
// Deliberately lenient — this validates shape, not carrier, and never blocks
// checkout over formatting.
const nepaliPhone = z
  .string()
  .trim()
  .regex(/^(?:\+977[-\s]?)?0?9\d{9}$/, 'Enter a valid Nepal phone number');

const idParam = z.object({ id });

const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = { z, email, password, shortText, id, idParam, paginationQuery, nepaliPhone };
