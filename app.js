'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const apiRouter = require('./routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const requestId = require('./middleware/requestId');

const app = express();

app.set('trust proxy', 1);
app.use(requestId);
// Guest access tokens are part of guest-order URLs. Never send them as a
// Referer, including to our own pages or third-party payment/chat links.
app.use(helmet({ referrerPolicy: { policy: 'no-referrer' } }));
app.use(
  cors({
    origin: env.clientOrigin.split(',').map((s) => s.trim()),
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Guest access tokens live in URL paths by design. Never write them to logs.
const redactGuestTokenPath = (url = '') => url.replace(/(\/api\/guest-checkout\/orders\/)[^/?]+/g, '$1<redacted>');
if (!env.isTest) app.use(morgan((tokens, req, res) => [tokens.method(req, res), redactGuestTokenPath(req.originalUrl), tokens.status(req, res), `${tokens['response-time'](req, res)} ms`].join(' ')));

// Broad abuse guard for the whole API; sensitive routes add tighter ones.
// Generous per IP because many customers can share one public IP (mobile
// CGNAT) and every storefront page view makes several API calls.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3000,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Serve uploaded product images. The storefront runs on another origin, so
// these public images (only) may be embedded cross-origin; helmet's default
// same-origin resource policy stays on for everything else. Payment proofs
// live in PRIVATE_UPLOAD_DIR, outside this directory, and are only readable
// through the authenticated staff endpoint.
app.use('/uploads', (req, res, next) => {
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.resolve(__dirname, env.uploads.dir), { index: false, dotfiles: 'deny' }));

app.use('/api', apiRouter);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
