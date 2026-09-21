'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const ApiError = require('../utils/ApiError');

const proofDir = path.resolve(__dirname, '..', 'private-uploads', 'payment-proofs');
fs.mkdirSync(proofDir, { recursive: true });

const allowed = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, proofDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${allowed.get(file.mimetype) || '.bin'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!allowed.has(file.mimetype)) return cb(ApiError.badRequest('Upload a JPG, PNG, or WebP image under 5 MB.', 'invalid_payment_proof'));
    cb(null, true);
  },
});

module.exports = { single: upload.single('proof'), proofDir };
