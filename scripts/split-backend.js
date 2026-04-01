/**
 * Splits the Python backend into <2GB chunks for GitHub release upload.
 *
 * Usage: node scripts/split-backend.js
 *
 * 1. Zips python-dist/murmur-backend/ using PowerShell
 * 2. Splits into 1.8 GB parts
 * 3. SHA-256 checksums each part + whole zip
 * 4. Writes backend-manifest.json
 * 5. Prints gh release upload commands
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PART_SIZE = Math.floor(1.8 * 1024 * 1024 * 1024); // 1.8 GB
const SRC_DIR = path.join(__dirname, '..', 'python-dist', 'murmur-backend');
const OUT_DIR = path.join(__dirname, '..', 'release-assets');
const ZIP_PATH = path.join(OUT_DIR, 'murmur-backend.zip');

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const CHUNK = 64 * 1024 * 1024; // 64 MB read chunks
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(CHUNK);
  let bytesRead;
  while ((bytesRead = fs.readSync(fd, buf, 0, CHUNK)) > 0) {
    hash.update(buf.subarray(0, bytesRead));
  }
  fs.closeSync(fd);
  return hash.digest('hex');
}

function main() {
  console.log('=== Murmur Backend Splitter ===\n');

  // Verify source exists
  if (!fs.existsSync(path.join(SRC_DIR, 'murmur-backend.exe'))) {
    console.error(`ERROR: ${SRC_DIR}/murmur-backend.exe not found.`);
    console.error('Run "npm run build:python" first.');
    process.exit(1);
  }

  // Create output dir
  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Step 1: Zip
  console.log(`[1/4] Zipping ${SRC_DIR}...`);
  console.log('       This may take several minutes for ~5 GB of data...');
  execSync(
    `powershell.exe -NoProfile -Command "Compress-Archive -Path '${SRC_DIR}\\*' -DestinationPath '${ZIP_PATH}' -Force"`,
    { stdio: 'inherit', timeout: 1200000 } // 20 min
  );

  const zipSize = fs.statSync(ZIP_PATH).size;
  console.log(`       Zip size: ${(zipSize / 1e9).toFixed(2)} GB\n`);

  // Step 2: SHA-256 of full zip
  console.log('[2/4] Computing full zip checksum...');
  const fullHash = sha256(ZIP_PATH);
  console.log(`       SHA-256: ${fullHash}\n`);

  // Step 3: Split
  console.log('[3/4] Splitting into parts...');
  const parts = [];
  const fd = fs.openSync(ZIP_PATH, 'r');
  let offset = 0;
  let partNum = 1;
  const readBuf = Buffer.alloc(8 * 1024 * 1024); // 8 MB read buffer

  while (offset < zipSize) {
    const partFilename = `murmur-backend.zip.${String(partNum).padStart(3, '0')}`;
    const partPath = path.join(OUT_DIR, partFilename);
    const partEnd = Math.min(offset + PART_SIZE, zipSize);
    const partSize = partEnd - offset;

    const partFd = fs.openSync(partPath, 'w');
    const partHash = crypto.createHash('sha256');
    let written = 0;

    while (written < partSize) {
      const toRead = Math.min(readBuf.length, partSize - written);
      const bytesRead = fs.readSync(fd, readBuf, 0, toRead, offset + written);
      fs.writeSync(partFd, readBuf, 0, bytesRead);
      partHash.update(readBuf.subarray(0, bytesRead));
      written += bytesRead;
    }

    fs.closeSync(partFd);

    const hash = partHash.digest('hex');
    parts.push({ filename: partFilename, size: partSize, sha256: hash });
    console.log(`       ${partFilename}: ${(partSize / 1e9).toFixed(2)} GB (${hash.substring(0, 16)}...)`);

    offset += partSize;
    partNum++;
  }
  fs.closeSync(fd);

  // Remove the full zip to save disk space
  fs.unlinkSync(ZIP_PATH);
  console.log(`       Split into ${parts.length} parts\n`);

  // Step 4: Write manifest
  console.log('[4/4] Writing manifest...');
  const manifest = {
    version: require('../package.json').version,
    totalSize: zipSize,
    sha256: fullHash,
    parts
  };

  const manifestPath = path.join(OUT_DIR, 'backend-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`       Written to ${manifestPath}\n`);

  // Print upload commands
  console.log('=== Upload Commands ===\n');
  const assetFiles = ['backend-manifest.json', ...parts.map(p => p.filename)];
  const assetArgs = assetFiles.map(f => `release-assets/${f}`).join(' ');
  console.log(`gh release create v${manifest.version} ${assetArgs} --title "Murmur v${manifest.version}" --notes "Initial release"`);
  console.log('');
  console.log('Or to add assets to an existing release:');
  console.log(`gh release upload v${manifest.version} ${assetArgs}`);
  console.log('\nDone!');
}

main();
