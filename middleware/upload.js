'use strict';

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const sharp = require('sharp');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

const uploadPath = path.resolve(__dirname, '..', env.uploads.dir);
fs.mkdirSync(uploadPath, { recursive: true });

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: env.uploads.maxMb * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(ApiError.badRequest('Unsupported image type', 'bad_image_type'));
    }
    cb(null, true);
  },
});

/**
 * After multer writes the raw files to disk, downscale + recompress them in
 * place so product photos ship at a sane web weight. Keeps the same filename
 * and extension (so stored URLs don't change); GIFs are passed through
 * untouched to preserve animation.
 */
const MAX_EDGE = 1600;

async function compressUploads(req, res, next) {
  const files = req.files || (req.file ? [req.file] : []);
  try {
    await Promise.all(
      files.map(async (file) => {
        if (file.mimetype === 'image/gif') return;
        const ext = path.extname(file.path).toLowerCase();
        const tmp = `${file.path}.tmp`;
        let pipeline = sharp(file.path, { failOn: 'none' })
          .rotate()
          .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });

        if (ext === '.png') pipeline = pipeline.png({ compressionLevel: 9, palette: true });
        else if (ext === '.webp') pipeline = pipeline.webp({ quality: 80 });
        else pipeline = pipeline.jpeg({ quality: 78, mozjpeg: true });

        await pipeline.toFile(tmp);
        const before = fs.statSync(file.path).size;
        const after = fs.statSync(tmp).size;
        // Only keep the recompressed file if it actually got smaller.
        if (after < before) {
          fs.renameSync(tmp, file.path);
          file.size = after;
        } else {
          fs.unlinkSync(tmp);
        }
      })
    );
    next();
  } catch (err) {
    next(err);
  }
}

/** Wrap an upload handler so compression runs right after it. */
function withCompression(multerHandler) {
  return [multerHandler, compressUploads];
}

upload.arrayCompressed = (field, max) => withCompression(upload.array(field, max));
upload.singleCompressed = (field) => withCompression(upload.single(field));

module.exports = upload;
module.exports.compressUploads = compressUploads;
