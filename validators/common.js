'use strict';

const { z } = require('zod');

const email = z.string().trim().toLowerCase().email().max(190);
const password = z.string().min(8).max(128);
const shortText = (max) => z.string().trim().min(1).max(max);
const id = z.coerce.number().int().positive();

const idParam = z.object({ id });

const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = { z, email, password, shortText, id, idParam, paginationQuery };
