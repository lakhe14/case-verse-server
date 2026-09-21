'use strict';

/**
 * One-off: downscale + recompress every image already in server/uploads to a
 * sane web weight, in place (same filename, so stored image URLs don't change).
 * New uploads are compressed automatically by middleware/upload.js.
 *
 * Usage: node scripts/compressUploads.js
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DIR = path.resolve(__dirname, '..', 'uploads');
const MAX_EDGE = 1600;

async function main() {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f));

  let totalBefore = 0;
  let totalAfter = 0;
  const changed = [];

  for (const name of files) {
    const full = path.join(DIR, name);
    const ext = path.extname(name).toLowerCase();
    const before = fs.statSync(full).size;
    totalBefore += before;

    const tmp = `${full}.tmp`;
    let pipeline = sharp(full, { failOn: 'none' })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    if (ext === '.png') pipeline = pipeline.png({ compressionLevel: 9, palette: true });
    else if (ext === '.webp') pipeline = pipeline.webp({ quality: 80 });
    else pipeline = pipeline.jpeg({ quality: 78, mozjpeg: true });

    // eslint-disable-next-line no-await-in-loop
    await pipeline.toFile(tmp);
    const after = fs.statSync(tmp).size;

    if (after < before) {
      fs.renameSync(tmp, full);
      totalAfter += after;
      changed.push({ name, before, after });
    } else {
      fs.unlinkSync(tmp);
      totalAfter += before;
    }
  }

  const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
  changed.sort((a, b) => b.before - b.after - (a.before - a.after));
  console.info(`Recompressed ${changed.length} of ${files.length} image(s).`);
  console.info('Biggest savings:');
  for (const c of changed.slice(0, 10)) {
    const pct = (((c.before - c.after) / c.before) * 100).toFixed(0);
    console.info(`  ${c.name}  ${kb(c.before)} -> ${kb(c.after)}  (-${pct}%)`);
  }
  console.info(
    `Total: ${(totalBefore / 1024 / 1024).toFixed(2)}MB -> ${(totalAfter / 1024 / 1024).toFixed(2)}MB`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
