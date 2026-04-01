const { app, BrowserWindow, ipcMain, dialog, shell, desktopCapturer, session, globalShortcut, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const WebSocket = require('ws');

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
  'tiny':      { id: 'tiny',      label: 'Tiny',     size: '~75 MB',  params: '39M'  },
  'base':      { id: 'base',      label: 'Base',     size: '~140 MB', params: '74M'  },
  'small':     { id: 'small',     label: 'Small',    size: '~460 MB', params: '244M' },
  'medium':    { id: 'medium',    label: 'Medium',   size: '~1.5 GB', params: '769M' },
  'large-v3':  { id: 'large-v3',  label: 'Large v3', size: '~3 GB',   params: '1.5B' },
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
        modelSize: 'base',
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

  // In packaged app, extraResources are at process.resourcesPath/python-backend
  // In dev, check python-dist/murmur-backend relative to project root
  const packagedExe = path.join(process.resourcesPath, 'python-backend', 'murmur-backend.exe');
  const devExe = path.join(__dirname, 'python-dist', 'murmur-backend', 'murmur-backend.exe');
  let cmd, args, cwd;

  if (fs.existsSync(packagedExe)) {
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
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
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
  });
}

function connectWebSocket() {
  if (ws) return;

  ws = new WebSocket(`ws://localhost:${PY_PORT}`, { maxPayload: 500 * 1024 * 1024 });

  ws.on('open', async () => {
    console.log('[Murmur] WebSocket connected to Python backend');
    wsReady = true;
    send('status', 'ML backend connected — loading models...');

    // Preload models in background so first transcription is instant
    try {
      const store = await getStore();
      const modelSize = store.get('modelSize') || 'base';
      const summaryModelKey = store.get('summaryModel') || 'qwen2.5-3b';
      sendToPython('preload-models', { modelSize, summaryModelKey })
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

  return new Promise((resolve, reject) => {
    const requestId = String(++requestCounter);
    pendingRequests.set(requestId, { resolve, reject });

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
  startPython();

  // If Python server was already running, try connecting immediately
  setTimeout(() => {
    if (!ws) connectWebSocket();
  }, 1000);

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
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  killPython();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

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
ipcMain.handle('settings:get', async () => {
  const store = await getStore();
  return store.store;
});

ipcMain.handle('settings:set', async (_e, key, value) => {
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
    const modelSize = store.get('modelSize') || 'base';
    const lang = store.get('language') || 'auto';

    send('status', 'Sending audio to ML backend...');

    const audioBase64 = float32ToBase64(audioFloat32);

    const result = await sendToPython('transcribe', {
      audioBase64,
      sampleRate,
      modelSize,
      language: lang === 'auto' ? null : lang,
    });

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
    const modelSize = store.get('modelSize') || 'base';
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
    const modelSize = store.get('modelSize') || 'base';
    const lang = store.get('language') || 'auto';

    send('status', 'Sending audio to ML backend...');
    console.log(`[Call IPC] wsReady=${wsReady}, micFloat32=${micFloat32.length}, sysFloat32=${sysFloat32.length}`);

    const micBase64 = float32ToBase64(micFloat32);
    const sysBase64 = float32ToBase64(sysFloat32);
    console.log(`[Call IPC] micBase64=${micBase64.length} chars, sysBase64=${sysBase64.length} chars, sending...`);

    const result = await sendToPython('transcribe-call', {
      micBase64,
      sysBase64,
      sampleRate,
      modelSize,
      language: lang === 'auto' ? null : lang,
    });

    send('status', 'Done');
    return result;
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

  const outDir = path.join(vaultPath, subfolder);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '');
  const filename = `${dateStr}_${timeStr}_${mode}.md`;

  const durationMin = Math.floor(duration / 60);
  const durationSec = Math.round(duration % 60);
  const durationStr = `${durationMin}m ${durationSec}s`;

  const type = mode === 'call' ? 'meeting' : 'fleeting';
  const tags = mode === 'call'
    ? ['log/meeting', 'status/inbox', 'source/murmur']
    : ['log/memo', 'status/inbox', 'source/murmur'];

  const hasSpeakers = chunks && chunks.some(c => c.speaker);
  const attendees = hasSpeakers
    ? [...new Set(chunks.map(c => c.speaker).filter(Boolean))]
    : [mode === 'call' ? 'You, Remote' : 'You'];

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
  shell.showItemInFolder(filePath);
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
