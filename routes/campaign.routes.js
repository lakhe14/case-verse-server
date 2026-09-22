'use strict';

const express = require('express');
const { getCampaign } = require('../services/campaign.service');

const router = express.Router();

// Public — the client reads the same fixed window the server enforces.
router.get('/dashain', (req, res) => {
  res.json({ data: getCampaign() });
});

module.exports = router;
