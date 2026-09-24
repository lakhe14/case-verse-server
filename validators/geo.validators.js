'use strict';

const { z } = require('./common');

// The precise position is accepted here only to be rounded by the service;
// it is never echoed back, logged or stored.
const reverseSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});

// Search text travels in the body so it never lands in URL access logs.
const localitySearchSchema = z.object({
  q: z.string().trim().min(1).max(80),
});

module.exports = { reverseSchema, localitySearchSchema };
