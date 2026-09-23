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

const formatForMime = new Map([
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
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

/**
 * Multer's MIME field is supplied by the client. Verify the decoded image and
 * re-encode it before it becomes a payment proof, which both rejects spoofed
 * files and removes metadata. The files remain outside the public web root.
 */
async function validateAndNormalize(req, _res, next) {
  const file = req.file;
  if (!file) return next();

  try {
    // sharp is already a production dependency for catalog-image processing.
    const sharp = require('sharp'); // lazy load keeps non-upload startup small
    const image = sharp(file.path, { limitInputPixels: 40_000_000, failOn: 'error' });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.format !== formatForMime.get(file.mimetype)) {
      throw ApiError.badRequest('Upload a valid JPG, PNG, or WebP image.', 'invalid_payment_proof');
    }

    const tempPath = `${file.path}.validated`;
    if (file.mimetype === 'image/png') await image.rotate().png({ compressionLevel: 9 }).toFile(tempPath);
    else if (file.mimetype === 'image/webp') await image.rotate().webp({ quality: 85 }).toFile(tempPath);
    else await image.rotate().jpeg({ quality: 85, mozjpeg: true }).toFile(tempPath);
    await fs.promises.rename(tempPath, file.path);
    return next();
  } catch (error) {
    await fs.promises.unlink(file.path).catch(() => {});
    return next(error instanceof ApiError
      ? error
      : ApiError.badRequest('Upload a valid JPG, PNG, or WebP image.', 'invalid_payment_proof'));
  }
}

module.exports = { single: [upload.single('proof'), validateAndNormalize], proofDir };
