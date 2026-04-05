const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const GITHUB_REPO = 'jlevy-dev/Murmur';
const BACKEND_DIR_NAME = 'python-backend';

function getBackendDir() {
  return path.join(app.getPath('userData'), BACKEND_DIR_NAME);
}

function getBackendExePath() {
  return path.join(getBackendDir(), 'murmur-backend.exe');
}

function isBackendInstalled() {
  return fs.existsSync(getBackendExePath());
}

// Fetch JSON from a URL (follows redirects)
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'Murmur' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${u}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON from manifest')); }
        });
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

// Download a file with progress callback, follows redirects
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let downloadedBytes = 0;

    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'Murmur' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const totalBytes = parseInt(res.headers['content-length'], 10) || 0;

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          file.write(chunk);
          if (onProgress) onProgress(chunk.length, downloadedBytes, totalBytes);
        });

        res.on('end', () => {
          file.end(() => resolve(downloadedBytes));
        });

        res.on('error', (err) => {
          file.close();
          reject(err);
        });
      }).on('error', (err) => {
        file.close();
        reject(err);
      });
    };
    get(url);
  });
}

// SHA-256 checksum of a file (streaming — handles files >2 GB)
function checksumFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Concatenate split parts into a single file
function concatenateParts(parts, tempDir, outputPath) {
  const out = fs.createWriteStream(outputPath);
  return new Promise((resolve, reject) => {
    let i = 0;
    function writeNext() {
      if (i >= parts.length) {
        out.end(resolve);
        return;
      }
      const partPath = path.join(tempDir, parts[i].filename);
      const stream = fs.createReadStream(partPath);
      stream.pipe(out, { end: false });
      stream.on('end', () => { i++; writeNext(); });
      stream.on('error', reject);
    }
    writeNext();
  });
}

// Extract zip using .NET ZipFile (streaming, doesn't load entire zip into memory)
function extractZip(zipPath, destDir) {
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -Assembly System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath}', '${destDir}')`
    ], { stdio: 'pipe' });

    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Extraction failed (code ${code}): ${stderr}`));
    });
    child.on('error', reject);
  });
}

async function downloadBackend(window) {
  const send = (data) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('backend-download-progress', data);
    }
  };

  const tempDir = path.join(app.getPath('userData'), 'backend-download-temp');
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 1. Fetch manifest from latest release
    send({ stage: 'fetching-manifest', percent: 0 });
    const manifestUrl = `https://github.com/${GITHUB_REPO}/releases/latest/download/backend-manifest.json`;
    const manifest = await fetchJson(manifestUrl);
    console.log(`[Downloader] Manifest: ${manifest.parts.length} parts, ${(manifest.totalSize / 1e9).toFixed(1)} GB`);

    // 2. Download each part
    let totalDownloaded = 0;
    const totalSize = manifest.totalSize;

    for (let p = 0; p < manifest.parts.length; p++) {
      const part = manifest.parts[p];
      const partPath = path.join(tempDir, part.filename);

      // Resume: skip if already downloaded and valid
      if (fs.existsSync(partPath)) {
        const stat = fs.statSync(partPath);
        if (stat.size === part.size) {
          console.log(`[Downloader] Part ${part.filename} already cached, skipping`);
          totalDownloaded += part.size;
          send({
            stage: 'downloading',
            percent: (totalDownloaded / totalSize) * 100,
            detail: `Part ${p + 1}/${manifest.parts.length} (cached)`
          });
          continue;
        }
      }

      const partUrl = `https://github.com/${GITHUB_REPO}/releases/latest/download/${part.filename}`;
      console.log(`[Downloader] Downloading ${part.filename}...`);

      await downloadFile(partUrl, partPath, (chunkBytes, downloaded, partTotal) => {
        send({
          stage: 'downloading',
          percent: ((totalDownloaded + downloaded) / totalSize) * 100,
          detail: `Part ${p + 1}/${manifest.parts.length} — ${((totalDownloaded + downloaded) / 1e9).toFixed(1)} / ${(totalSize / 1e9).toFixed(1)} GB`
        });
      });

      totalDownloaded += part.size;

      // Verify part checksum
      send({ stage: 'verifying', percent: (totalDownloaded / totalSize) * 100, detail: `Verifying part ${p + 1}...` });
      const hash = await checksumFile(partPath);
      if (hash !== part.sha256) {
        fs.unlinkSync(partPath);
        throw new Error(`Checksum mismatch for ${part.filename}. Please retry.`);
      }
    }

    // 3. Concatenate parts into single zip
    send({ stage: 'assembling', percent: 100, detail: 'Assembling archive...' });
    const zipPath = path.join(tempDir, 'murmur-backend.zip');
    await concatenateParts(manifest.parts, tempDir, zipPath);

    // 4. Skip full zip checksum — individual parts already verified
    // Hashing 3GB synchronously would block the UI

    // 5. Extract to a temp extraction dir first
    send({ stage: 'extracting', percent: 100, detail: 'Extracting ML engine (this may take a few minutes)...' });
    const extractDir = path.join(app.getPath('userData'), 'backend-extract-temp');
    await extractZip(zipPath, extractDir);

    // 6. Move files to final location
    // The zip contains a "murmur-backend/" subfolder, so the exe is at extractDir/murmur-backend/murmur-backend.exe
    const backendDir = getBackendDir();
    const subfolderExe = path.join(extractDir, 'murmur-backend', 'murmur-backend.exe');
    const directExe = path.join(extractDir, 'murmur-backend.exe');

    if (fs.existsSync(subfolderExe)) {
      // Zip had a subfolder — move that subfolder to become the backend dir
      if (fs.existsSync(backendDir)) fs.rmSync(backendDir, { recursive: true, force: true });
      fs.renameSync(path.join(extractDir, 'murmur-backend'), backendDir);
      fs.rmSync(extractDir, { recursive: true, force: true });
    } else if (fs.existsSync(directExe)) {
      // Zip had files at root — just rename the extract dir
      if (fs.existsSync(backendDir)) fs.rmSync(backendDir, { recursive: true, force: true });
      fs.renameSync(extractDir, backendDir);
    } else {
      throw new Error('Extraction failed — murmur-backend.exe not found in archive');
    }

    if (!fs.existsSync(getBackendExePath())) {
      throw new Error('Extraction failed — murmur-backend.exe not found after move');
    }

    // 7. Cleanup temp files
    fs.rmSync(tempDir, { recursive: true, force: true });

    send({ stage: 'done', percent: 100, detail: 'ML engine installed!' });
    console.log('[Downloader] Backend installed successfully');

  } catch (err) {
    console.error('[Downloader] Error:', err);
    send({ stage: 'error', percent: 0, detail: err.message });
    throw err;
  }
}

module.exports = { getBackendDir, getBackendExePath, isBackendInstalled, downloadBackend };
