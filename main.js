const { app, BrowserWindow, ipcMain, dialog, shell, desktopCapturer, session, globalShortcut, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const WebSocket = require('ws');
const { getBackendDir, getBackendExePath, isBackendInstalled, downloadBackend } = require('./backend-downloader');
const { autoUpdater } = require('electron-updater');

// Force Electron to use the discrete GPU instead of integrated
app.commandLine.appendSwitch('force_high_performance_gpu');

let mainWindow;
let tray = null;
let Store;
let storeInstance = null;
let pyProcess = null;
let ws = null;
let wsReady = false;
let pendingRequests = new Map();
let requestCounter = 0;
let reconnectTimer = null;

const PY_PORT = 9735;

const MODELS = {
  'parakeet-tdt-0.6b': { id: 'parakeet-tdt-0.6b', label: 'Parakeet TDT 0.6B', size: '~700 MB', params: '600M' },
  'parakeet-tdt-1.1b': { id: 'parakeet-tdt-1.1b', label: 'Parakeet TDT 1.1B', size: '~1.3 GB', params: '1.1B' },
};

const SUMMARY_MODELS = {
  'qwen2.5-1.5b': { id: 'Qwen/Qwen2.5-1.5B-Instruct', label: 'Qwen2.5 1.5B', size: '~1.2 GB', params: '1.5B' },
  'qwen2.5-3b':   { id: 'Qwen/Qwen2.5-3B-Instruct',   label: 'Qwen2.5 3B',   size: '~2.4 GB', params: '3B'   },
  'phi-3.5-mini':  { id: 'microsoft/Phi-3.5-mini-instruct', label: 'Phi 3.5 Mini', size: '~2.8 GB', params: '3.8B' },
};

const LANGUAGES = {
  auto:  'Auto-detect',
  en:    'English',
  de:    'German',
  es:    'Spanish',
  fr:    'French',
  it:    'Italian',
  pt:    'Portuguese',
  nl:    'Dutch',
  pl:    'Polish',
  ru:    'Russian',
  uk:    'Ukrainian',
  sv:    'Swedish',
  da:    'Danish',
  fi:    'Finnish',
  no:    'Norwegian',
  cs:    'Czech',
  ro:    'Romanian',
  hu:    'Hungarian',
  bg:    'Bulgarian',
  hr:    'Croatian',
  sk:    'Slovak',
  sl:    'Slovenian',
  et:    'Estonian',
  lv:    'Latvian',
  lt:    'Lithuanian',
  el:    'Greek',
  ja:    'Japanese',
  zh:    'Chinese',
  ko:    'Korean',
  hi:    'Hindi',
  ar:    'Arabic',
  tr:    'Turkish',
};

async function getStore() {
  if (!Store) {
    const mod = await import('electron-store');
    Store = mod.default;
  }
  if (!storeInstance) {
    storeInstance = new Store({
      defaults: {
        vaultPath: '',
        vaultSubfolder: 'Murmur',
        language: 'auto',
        modelSize: 'parakeet-tdt-0.6b',
        summaryModel: 'qwen2.5-3b',
        silenceTimeout: 120,
        hideFromScreenShare: true
      }
    });
  }
  return storeInstance;
}

// ── Python backend management ───────────────────────────────────────────────

function startPython() {
  const pyDir = path.join(__dirname, 'python');
  const env = { ...process.env, PYTHONUNBUFFERED: '1', CUDA_VISIBLE_DEVICES: '0' };

  // Priority 1: Downloaded backend in userData (from GitHub release)
  const userDataExe = getBackendExePath();
  // Priority 2: Bundled with app via extraResources (legacy)
  const packagedExe = path.join(process.resourcesPath, 'python-backend', 'murmur-backend.exe');
  // Priority 3: Local build (dev)
  const devExe = path.join(__dirname, 'python-dist', 'murmur-backend', 'murmur-backend.exe');
  let cmd, args, cwd;

  if (fs.existsSync(userDataExe)) {
    cmd = userDataExe;
    args = [];
    cwd = getBackendDir();
    console.log(`[Murmur] Starting downloaded Python backend: ${cmd}`);
  } else if (fs.existsSync(packagedExe)) {
    cmd = packagedExe;
    args = [];
    cwd = path.join(process.resourcesPath, 'python-backend');
    console.log(`[Murmur] Starting packaged Python backend: ${cmd}`);
  } else if (fs.existsSync(devExe)) {
    cmd = devExe;
    args = [];
    cwd = path.join(__dirname, 'python-dist', 'murmur-backend');
    console.log(`[Murmur] Starting bundled Python backend: ${cmd}`);
  } else {
    // Prefer the project venv (Python 3.12 + NeMo), fall back to system python
    const venvPython = path.join(pyDir, '.venv', 'Scripts', 'python.exe');
    const pythonCmd = fs.existsSync(venvPython) ? venvPython
      : (process.platform === 'win32' ? 'python' : 'python3');
    cmd = pythonCmd;
    args = [path.join(pyDir, 'server.py')];
    cwd = pyDir;
    console.log(`[Murmur] Starting Python backend: ${cmd} ${args[0]}`);
  }

  pyProcess = spawn(cmd, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  });

  pyProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[Python] ${msg}`);
    // Connect WebSocket once server is ready
    if (msg.includes('Ready') && !ws) {
      connectWebSocket();
    }
  });

  pyProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[Python ERR] ${msg}`);
  });

  pyProcess.on('exit', (code) => {
    console.log(`[Murmur] Python process exited with code ${code}`);
    pyProcess = null;
    wsReady = false;
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    // Notify renderer and auto-restart (unless app is quitting)
    if (!app.isQuitting) {
      send('status', 'ML backend crashed — restarting...');
      console.log('[Murmur] Scheduling backend restart in 3s...');
      setTimeout(() => {
        if (!pyProcess && !app.isQuitting) {
          console.log('[Murmur] Restarting Python backend...');
          startPython();
        }
      }, 3000);
    }
  });
}

function connectWebSocket() {
  if (ws) return;

  ws = new WebSocket(`ws://localhost:${PY_PORT}`, { maxPayload: 500 * 1024 * 1024 });

  ws.on('open', async () => {
    console.log('[Murmur] WebSocket connected to Python backend');
    wsReady = true;
    send('status', 'ML backend connected — loading models...');

    // Preload only the transcription model on startup (saves ~2-3 GB VRAM).
    // The summary model loads on-demand when the user clicks Summarize.
    try {
      const store = await getStore();
      const modelSize = store.get('modelSize') || 'parakeet-tdt-0.6b';
      sendToPython('load-model', { task: 'transcription', modelSize })
        .then(() => send('status', 'Ready'))
        .catch(err => console.error('[Murmur] Preload failed:', err.message));
    } catch (err) {
      console.error('[Murmur] Preload error:', err);
    }
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const reqId = msg.requestId;

      if (msg.type === 'progress') {
        send('status', msg.status);
        if (msg.percent !== undefined) {
          send('model-progress', { status: 'download', progress: msg.percent });
        }
      } else if (msg.type === 'result' && reqId && pendingRequests.has(reqId)) {
        const { resolve } = pendingRequests.get(reqId);
        pendingRequests.delete(reqId);
        resolve(msg.data);
      } else if (msg.type === 'error' && reqId && pendingRequests.has(reqId)) {
        const { reject } = pendingRequests.get(reqId);
        pendingRequests.delete(reqId);
        reject(new Error(msg.message));
      }
    } catch (err) {
      console.error('[Murmur] Failed to parse WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    console.log('[Murmur] WebSocket disconnected');
    ws = null;
    wsReady = false;
    // Reject all pending requests so they don't hang forever
    for (const [reqId, { reject }] of pendingRequests) {
      reject(new Error('WebSocket disconnected'));
    }
    pendingRequests.clear();
    // Reconnect after 3s if Python is still running
    if (pyProcess && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!ws) connectWebSocket();
      }, 3000);
    }
  });

  ws.on('error', () => {
    // Will trigger 'close' handler — don't log to reduce noise
  });
}

const REQUEST_TIMEOUTS = {
  'ping':             10_000,
  'gpu-info':         10_000,
  'load-model':      120_000,
  'preload-models':  300_000,
  'transcribe':      600_000,
  'transcribe-call': 600_000,
  'transcribe-stream': 120_000,
  'summarize':       300_000,
  'unload':           10_000,
};

async function sendToPython(type, payload = {}) {
  // Wait up to 30s for the backend to connect
  if (!wsReady || !ws) {
    send('status', 'Waiting for ML backend...');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (wsReady && ws) break;
    }
    if (!wsReady || !ws) {
      throw new Error('Python backend not connected after 30s');
    }
  }

  const timeoutMs = REQUEST_TIMEOUTS[type] || 60_000;

  return new Promise((resolve, reject) => {
    const requestId = String(++requestCounter);

    const timer = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        const err = new Error(`Request '${type}' timed out after ${timeoutMs / 1000}s`);
        console.error(`[Murmur] ${err.message}`);
        reject(err);
      }
    }, timeoutMs);

    pendingRequests.set(requestId, {
      resolve: (data) => { clearTimeout(timer); resolve(data); },
      reject:  (err)  => { clearTimeout(timer); reject(err); },
    });

    const msg = JSON.stringify({ type, requestId, ...payload });
    ws.send(msg);
  });
}

function float32ToBase64(float32Array) {
  // Convert Float32Array (or plain array) to base64
  const f32 = float32Array instanceof Float32Array
    ? float32Array
    : new Float32Array(float32Array);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  return Buffer.from(bytes).toString('base64');
}

// ── Audio chunking for long recordings ──────────────────────────────────────
const CHUNK_DURATION = 5 * 60; // 5 minutes per chunk
const CHUNK_OVERLAP  = 2;      // 2 seconds overlap for continuity

function splitAudioChunks(float32Array, sampleRate) {
  const chunkSamples = CHUNK_DURATION * sampleRate;
  const overlapSamples = CHUNK_OVERLAP * sampleRate;
  const totalSamples = float32Array.length;

  if (totalSamples <= chunkSamples) {
    return [{ audio: float32Array, offsetSec: 0 }];
  }

  const chunks = [];
  let start = 0;
  while (start < totalSamples) {
    const end = Math.min(start + chunkSamples, totalSamples);
    chunks.push({
      audio: float32Array.slice(start, end),
      offsetSec: start / sampleRate,
    });
    if (end >= totalSamples) break;
    start = end - overlapSamples; // overlap for smooth merging
  }
  return chunks;
}

function mergeChunkResults(results) {
  // Merge transcription results from multiple chunks, adjusting timestamps
  const allChunks = [];
  let fullText = '';

  for (const { result, offsetSec } of results) {
    if (!result) continue;
    if (result.text) {
      fullText += (fullText ? ' ' : '') + result.text.trim();
    }
    if (result.chunks) {
      for (const chunk of result.chunks) {
        const adjusted = { ...chunk };
        if (adjusted.timestamp) {
          adjusted.timestamp = adjusted.timestamp.map(t => t + offsetSec);
        }
        allChunks.push(adjusted);
      }
    }
  }

  // Deduplicate overlapping chunks by timestamp (remove near-duplicate entries)
  const deduped = [];
  for (const chunk of allChunks) {
    const ts = chunk.timestamp?.[0] ?? -1;
    const lastTs = deduped.length > 0 ? (deduped[deduped.length - 1].timestamp?.[0] ?? -2) : -2;
    // Skip if timestamp is within 1.5s of the last chunk and text is similar
    if (ts >= 0 && lastTs >= 0 && Math.abs(ts - lastTs) < 1.5) continue;
    deduped.push(chunk);
  }

  return {
    text: fullText,
    chunks: deduped,
    detectedLanguage: results[0]?.result?.detectedLanguage || 'unknown',
  };
}

async function transcribeChunked(audioFloat32, sampleRate, modelSize, language) {
  const chunks = splitAudioChunks(audioFloat32, sampleRate);
  const total = chunks.length;

  if (total === 1) {
    // Short recording — send as-is
    const audioBase64 = float32ToBase64(chunks[0].audio);
    return await sendToPython('transcribe', { audioBase64, sampleRate, modelSize, language });
  }

  console.log(`[Murmur] Splitting ${(audioFloat32.length / sampleRate / 60).toFixed(1)}min audio into ${total} chunks`);
  const results = [];

  for (let i = 0; i < total; i++) {
    send('status', `Transcribing chunk ${i + 1}/${total}…`);
    const audioBase64 = float32ToBase64(chunks[i].audio);
    const result = await sendToPython('transcribe', { audioBase64, sampleRate, modelSize, language });
    results.push({ result, offsetSec: chunks[i].offsetSec });
  }

  return mergeChunkResults(results);
}

function killPython() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  if (pyProcess) {
    try { pyProcess.kill(); } catch (_) {}
    pyProcess = null;
  }
}

// ── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 700,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#0a0a14',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0a14',
      symbolColor: '#8888aa',
      height: 36
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  getStore().then(store => {
    if (store.get('hideFromScreenShare')) {
      mainWindow.setContentProtection(true);
    }
  });

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => {
      callback(null);
    });
  });
}

app.whenReady().then(() => {
  createWindow();

  // Check if backend is installed (downloaded or bundled or dev)
  const hasBackend = isBackendInstalled()
    || fs.existsSync(path.join(process.resourcesPath, 'python-backend', 'murmur-backend.exe'))
    || fs.existsSync(path.join(__dirname, 'python-dist', 'murmur-backend', 'murmur-backend.exe'))
    || fs.existsSync(path.join(__dirname, 'python', 'server.py'));

  if (!hasBackend) {
    // Tell renderer to show download UI
    mainWindow.webContents.on('did-finish-load', () => {
      send('backend-missing', true);
    });
  } else {
    startPython();
    // WebSocket connects automatically when Python prints "Ready"
  }

  globalShortcut.register('Ctrl+Shift+R', () => {
    send('toggle-recording');
  });

  // ── System tray ──────────────────────────────────────────────────────────
  const trayIconDataURL =
    'data:image/png;base64,' +
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAaUlEQVR4' +
    'nGNgGAWjIUAIGBkZ/zMwMDD8//+fgRhAsgv+ExsGJLuAZBcwMjISHwak' +
    'uoB4FzAwMBDvAmJdQI4LiHYByS4g2gUku4BkF5DsApJdQLILSHYByS4g' +
    '2QUku4BoFzAyMo6mhFEAAHRzHhG1q3qeAAAAAElFTkSuQmCC';
  const trayIcon = nativeImage.createFromDataURL(trayIconDataURL);

  tray = new Tray(trayIcon);
  tray.setToolTip('Murmur');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Murmur',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      }
    },
    {
      label: 'Start/Stop Recording',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('toggle-recording');
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { app.quit(); }
    }
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  // ── Auto-update (silent check, no auto-download) ──────────────────────────
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log(`[Murmur] Update available: v${info.version}`);
    send('update-available', { version: info.version });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Murmur] Update downloaded: v${info.version}`);
    send('update-downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[Murmur] Auto-updater error:', err.message);
  });

  // Check for updates silently after a short delay
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.error('[Murmur] Update check failed:', err.message);
    });
  }, 5000);
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  killPython();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── IPC: Auto-update ──────────────────────────────────────────────────────
ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { updateAvailable: !!result?.updateInfo };
  } catch (err) {
    console.error('[Murmur] Manual update check failed:', err.message);
    return { updateAvailable: false, error: err.message };
  }
});

ipcMain.handle('download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    console.error('[Murmur] Update download failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

// ── IPC: Backend download ──────────────────────────────────────────────────
ipcMain.handle('start-backend-download', async () => {
  try {
    await downloadBackend(mainWindow);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('check-backend-installed', () => isBackendInstalled());

ipcMain.handle('launch-backend-after-download', () => {
  if (isBackendInstalled()) {
    startPython();
    return true;
  }
  return false;
});

// ── IPC: Constants ──────────────────────────────────────────────────────────
ipcMain.handle('get-models', () => MODELS);
ipcMain.handle('get-languages', () => LANGUAGES);
ipcMain.handle('get-summary-models', () => SUMMARY_MODELS);

// ── IPC: Detect conferencing app ─────────────────────────────────────────────
ipcMain.handle('detect-source-app', () => {
  try {
    const output = execSync('tasklist /FO CSV /NH', { encoding: 'utf-8', timeout: 5000 });
    const processNames = output.toLowerCase();

    const apps = [];
    if (processNames.includes('"teams.exe"')) apps.push('Microsoft Teams');
    if (processNames.includes('"zoom.exe"')) apps.push('Zoom');
    if (processNames.includes('"slack.exe"')) apps.push('Slack');
    if (processNames.includes('"discord.exe"')) apps.push('Discord');
    if (processNames.includes('"chrome.exe"') || processNames.includes('"msedge.exe"')) {
      apps.push('Browser (possible Meet/Webex)');
    }

    if (apps.length === 0) return 'Unknown';
    return apps.join(' + ');
  } catch (err) {
    console.error('Failed to detect source app:', err);
    return 'Unknown';
  }
});

// ── IPC: Settings ───────────────────────────────────────────────────────────
const ALLOWED_SETTINGS = new Set([
  'vaultPath', 'vaultSubfolder', 'language', 'modelSize',
  'summaryModel', 'silenceTimeout', 'hideFromScreenShare', 'compute',
]);

ipcMain.handle('settings:get', async () => {
  const store = await getStore();
  return store.store;
});

ipcMain.handle('settings:set', async (_e, key, value) => {
  if (!ALLOWED_SETTINGS.has(key)) {
    console.warn(`[Murmur] Rejected unknown setting key: ${key}`);
    return;
  }
  const store = await getStore();
  store.set(key, value);

  if (key === 'hideFromScreenShare' && mainWindow) {
    mainWindow.setContentProtection(!!value);
  }
});

ipcMain.handle('settings:setCompute', async (_e, value) => {
  const store = await getStore();
  store.set('compute', value);
});

ipcMain.handle('settings:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Obsidian Vault Folder'
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// ── IPC: Transcribe (voice memo — single channel) ───────────────────────────
ipcMain.handle('transcribe', async (_e, audioFloat32, sampleRate) => {
  try {
    const store = await getStore();
    const modelSize = store.get('modelSize') || 'parakeet-tdt-0.6b';
    const lang = store.get('language') || 'auto';
    const language = lang === 'auto' ? null : lang;

    send('status', 'Transcribing…');
    const result = await transcribeChunked(audioFloat32, sampleRate, modelSize, language);

    send('status', 'Done');
    return result;
  } catch (err) {
    console.error('Transcription error:', err);
    send('status', `Error: ${err.message}`);
    return { text: '', chunks: [], detectedLanguage: 'unknown' };
  }
});

// ── IPC: Stream transcribe (live preview during recording) ──────────────────
ipcMain.handle('transcribe-stream', async (_e, audioFloat32, sampleRate) => {
  try {
    const store = await getStore();
    const modelSize = store.get('modelSize') || 'parakeet-tdt-0.6b';
    const audioBase64 = float32ToBase64(audioFloat32);

    const result = await sendToPython('transcribe-stream', {
      audioBase64,
      sampleRate,
      modelSize,
    });

    return result;
  } catch (err) {
    return { text: '' };
  }
});

// ── IPC: Transcribe Call (dual channel — speaker diarization) ────────────────
ipcMain.handle('transcribe-call', async (_e, micFloat32, sysFloat32, sampleRate) => {
  try {
    const store = await getStore();
    const modelSize = store.get('modelSize') || 'parakeet-tdt-0.6b';
    const lang = store.get('language') || 'auto';
    const language = lang === 'auto' ? null : lang;

    send('status', 'Transcribing call…');
    console.log(`[Call IPC] micFloat32=${micFloat32.length}, sysFloat32=${sysFloat32.length}`);

    // Chunk both channels in sync so timestamps align
    const micChunks = splitAudioChunks(micFloat32, sampleRate);
    const sysChunks = splitAudioChunks(sysFloat32, sampleRate);
    const total = Math.max(micChunks.length, sysChunks.length);

    console.log(`[Call IPC] Split into ${total} chunk(s)`);

    if (total === 1) {
      // Short call — send as single message
      const result = await sendToPython('transcribe-call', {
        micBase64: float32ToBase64(micFloat32),
        sysBase64: float32ToBase64(sysFloat32),
        sampleRate,
        modelSize,
        language,
      });
      send('status', 'Done');
      return result;
    }

    // Long call — transcribe each channel in chunks, then merge
    const micResults = [];
    for (let i = 0; i < micChunks.length; i++) {
      send('status', `Transcribing mic ${i + 1}/${micChunks.length}…`);
      const audioBase64 = float32ToBase64(micChunks[i].audio);
      const result = await sendToPython('transcribe', { audioBase64, sampleRate, modelSize, language });
      // Tag all chunks as "You"
      if (result.chunks) result.chunks = result.chunks.map(c => ({ ...c, speaker: 'You' }));
      micResults.push({ result, offsetSec: micChunks[i].offsetSec });
    }

    const sysResults = [];
    for (let i = 0; i < sysChunks.length; i++) {
      send('status', `Transcribing system audio ${i + 1}/${sysChunks.length}…`);
      const audioBase64 = float32ToBase64(sysChunks[i].audio);
      const result = await sendToPython('transcribe', { audioBase64, sampleRate, modelSize, language });
      // Tag system chunks as "Other"
      if (result.chunks) result.chunks = result.chunks.map(c => ({ ...c, speaker: 'Other' }));
      sysResults.push({ result, offsetSec: sysChunks[i].offsetSec });
    }

    // Merge both channels
    const micMerged = mergeChunkResults(micResults);
    const sysMerged = mergeChunkResults(sysResults);

    const allChunks = [...micMerged.chunks, ...sysMerged.chunks];
    allChunks.sort((a, b) => (a.timestamp?.[0] ?? 0) - (b.timestamp?.[0] ?? 0));

    const fullText = allChunks.map(c => c.text.trim()).join(' ');

    send('status', 'Done');
    return {
      text: fullText,
      chunks: allChunks,
      detectedLanguage: micMerged.detectedLanguage,
    };
  } catch (err) {
    console.error('Call transcription error:', err);
    send('status', `Error: ${err.message}`);
    return { text: '', chunks: [], detectedLanguage: 'unknown' };
  }
});

// ── IPC: Summarize ──────────────────────────────────────────────────────────
ipcMain.handle('summarize', async (_e, text) => {
  try {
    const store = await getStore();
    const modelKey = store.get('summaryModel') || 'qwen2.5-3b';

    send('status', 'Summarizing...');

    const result = await sendToPython('summarize', {
      text,
      modelKey,
    });

    send('status', 'Summary complete');
    return result;
  } catch (err) {
    console.error('Summarization error:', err);
    send('status', `Summarization error: ${err.message}`);
    return { summary: '' };
  }
});

// ── IPC: Save transcript ────────────────────────────────────────────────────
ipcMain.handle('save-transcript', async (_e, data) => {
  const { mode, transcript, chunks, duration, sourceApp, detectedLanguage, summary } = data;
  const store = await getStore();
  const vaultPath = store.get('vaultPath');
  const subfolder = store.get('vaultSubfolder') || 'Murmur';

  if (!vaultPath) {
    return { success: false, error: 'No vault path configured — open Settings first' };
  }

  // Sanitize subfolder and mode to prevent path traversal
  const safeSubfolder = subfolder.replace(/[\\/:*?"<>|.]/g, '_');
  const safeMode = (mode === 'call' || mode === 'memo') ? mode : 'memo';

  const outDir = path.join(vaultPath, safeSubfolder);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Verify outDir is actually inside vaultPath
  const resolvedOut = path.resolve(outDir);
  const resolvedVault = path.resolve(vaultPath);
  if (!resolvedOut.startsWith(resolvedVault)) {
    return { success: false, error: 'Invalid subfolder path' };
  }

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '');
  const filename = `${dateStr}_${timeStr}_${safeMode}.md`;

  const durationMin = Math.floor(duration / 60);
  const durationSec = Math.round(duration % 60);
  const durationStr = `${durationMin}m ${durationSec}s`;

  const type = safeMode === 'call' ? 'meeting' : 'fleeting';
  const tags = safeMode === 'call'
    ? ['log/meeting', 'status/inbox', 'source/murmur']
    : ['log/memo', 'status/inbox', 'source/murmur'];

  const hasSpeakers = chunks && chunks.some(c => c.speaker);
  const attendees = hasSpeakers
    ? [...new Set(chunks.map(c => c.speaker).filter(Boolean))]
    : [safeMode === 'call' ? 'You, Remote' : 'You'];

  let body = '';
  if (chunks && chunks.length > 0) {
    for (const chunk of chunks) {
      const ts = chunk.timestamp;
      const tsStr = (ts && ts[0] !== undefined) ? `[${fmtTs(ts[0])}] ` : '';
      const speaker = chunk.speaker ? `**${chunk.speaker}:** ` : '';
      body += `${tsStr}${speaker}${chunk.text.trim()}\n\n`;
    }
  } else {
    body = transcript + '\n';
  }

  const langLabel = LANGUAGES[detectedLanguage] || detectedLanguage || 'unknown';

  const summaryBlock = (summary && summary.trim())
    ? `\n## Summary\n\n${summary.trim()}\n\n## Full Transcript\n\n`
    : '\n';

  const md = `---
type: ${type}
created: ${now.toISOString()}
time: "${now.toTimeString().split(' ')[0]}"
duration: "${durationStr}"
source_app: "${sourceApp || 'unknown'}"
language: "${langLabel}"
attendees:
${attendees.map(a => `  - "${a}"`).join('\n')}
tags:
${tags.map(t => `  - ${t}`).join('\n')}
---

# ${type === 'meeting' ? 'Meeting Transcript' : 'Voice Memo'}
${summaryBlock}${body}`;

  const filePath = path.join(outDir, filename);
  fs.writeFileSync(filePath, md, 'utf-8');

  const notif = new Notification({
    title: 'Murmur',
    body: 'Transcription complete — saved to vault'
  });
  notif.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notif.show();

  return { success: true, filePath };
});

ipcMain.handle('open-file', async (_e, filePath) => {
  // Only allow opening files inside the configured vault path
  const store = await getStore();
  const vaultPath = store.get('vaultPath');
  if (vaultPath && path.resolve(filePath).startsWith(path.resolve(vaultPath))) {
    shell.showItemInFolder(filePath);
  }
});

ipcMain.handle('notify', async (_e, title, body) => {
  const notif = new Notification({ title, body });
  notif.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notif.show();
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function fmtTs(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
