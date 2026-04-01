// ── State ────────────────────────────────────────────────────────────────────
let mode = 'memo';
let isRecording = false;
let audioContext = null;
let analyser = null;
let timerInterval = null;
let startTime = 0;
let silenceStart = 0;
let silenceTimeout = 120;
let lastTranscript = null;
let waveformAnim = null;
let meterAnim = null;
let models = {};
let languages = {};
let summaryModels = {};
let detectedSourceApp = null;
let liveInterval = null;
let liveTranscriptParts = [];
let isTranscribingLive = false;

// Single-channel (memo)
let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];

// Dual-channel (call) — separate mic and system recorders
let micStream = null;
let sysStream = null;
let displayStream = null; // keep alive for video tracks
let micRecorder = null;
let sysRecorder = null;
let micChunks = [];
let sysChunks = [];

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const views = {
  download: $('#view-download'),
  idle: $('#view-idle'),
  recording: $('#view-recording'),
  processing: $('#view-processing'),
  transcript: $('#view-transcript')
};

const btnRecord = $('#btn-record');
const timerEl = $('#timer');
const statusText = $('#status-text');
const modeButtons = document.querySelectorAll('.mode-btn');

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const [settings, mdls, langs, sumMdls] = await Promise.all([
    window.murmur.getSettings(),
    window.murmur.getModels(),
    window.murmur.getLanguages(),
    window.murmur.getSummaryModels()
  ]);

  models = mdls;
  languages = langs;
  summaryModels = sumMdls;
  silenceTimeout = settings.silenceTimeout || 120;

  // Populate model dropdown
  const modelSelect = $('#setting-model');
  for (const [key, m] of Object.entries(models)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${m.label} — ${m.size} (${m.params} params)`;
    if (key === settings.modelSize) opt.selected = true;
    modelSelect.appendChild(opt);
  }
  updateModelBadge(settings.modelSize);

  // Populate language dropdown
  const langSelect = $('#setting-language');
  for (const [code, name] of Object.entries(languages)) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    if (code === settings.language) opt.selected = true;
    langSelect.appendChild(opt);
  }

  // Populate summary model dropdown
  const summaryModelSelect = $('#setting-summary-model');
  for (const [key, m] of Object.entries(summaryModels)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${m.label} — ${m.size}`;
    if (key === settings.summaryModel) opt.selected = true;
    summaryModelSelect.appendChild(opt);
  }

  // Load other settings into UI
  $('#setting-vault').value = settings.vaultPath || '';
  $('#setting-subfolder').value = settings.vaultSubfolder || 'Murmur';
  $('#setting-silence').value = settings.silenceTimeout || 120;
  $('#setting-hide-screenshare').checked = settings.hideFromScreenShare !== false;

  // ── Event listeners ─────────────────────────────────────────────────────
  window.murmur.onStatus((msg) => {
    statusText.textContent = msg;
    if (views.processing.classList.contains('active')) {
      $('#processing-status').textContent = msg;
    }
  });

  window.murmur.onModelProgress((data) => {
    const bar = $('#model-progress-bar');
    const fill = $('#model-progress-fill');
    const procBar = $('#processing-progress-bar');
    const procFill = $('#processing-progress-fill');

    if (data.status === 'start') {
      bar.classList.remove('hidden');
      procBar.classList.remove('hidden');
      fill.style.width = '0%';
      procFill.style.width = '0%';
    } else if (data.status === 'download' && data.progress !== undefined) {
      const pct = Math.round(data.progress) + '%';
      fill.style.width = pct;
      procFill.style.width = pct;
    } else if (data.status === 'done') {
      fill.style.width = '100%';
      procFill.style.width = '100%';
      setTimeout(() => {
        bar.classList.add('hidden');
        procBar.classList.add('hidden');
      }, 1000);
    }
  });

  // Mode buttons
  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (isRecording) return;
      mode = btn.dataset.mode;
      modeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  btnRecord.addEventListener('click', toggleRecording);

  // Settings interactions
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-close-settings').addEventListener('click', closeSettings);
  $('.modal-backdrop').addEventListener('click', closeSettings);

  $('#btn-browse-vault').addEventListener('click', async () => {
    const folder = await window.murmur.pickFolder();
    if (folder) {
      $('#setting-vault').value = folder;
      window.murmur.setSetting('vaultPath', folder);
    }
  });

  modelSelect.addEventListener('change', (e) => {
    window.murmur.setSetting('modelSize', e.target.value);
    updateModelBadge(e.target.value);
  });

  langSelect.addEventListener('change', (e) => {
    window.murmur.setSetting('language', e.target.value);
  });

  $('#setting-subfolder').addEventListener('change', (e) => {
    window.murmur.setSetting('vaultSubfolder', e.target.value);
  });

  $('#setting-silence').addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    if (val >= 10) {
      silenceTimeout = val;
      window.murmur.setSetting('silenceTimeout', val);
    }
  });

  $('#setting-hide-screenshare').addEventListener('change', (e) => {
    window.murmur.setSetting('hideFromScreenShare', e.target.checked);
  });

  summaryModelSelect.addEventListener('change', (e) => {
    window.murmur.setSetting('summaryModel', e.target.value);
  });

  // Global hotkey: toggle recording from anywhere
  window.murmur.onToggleRecording(() => toggleRecording());

  // Transcript actions
  $('#btn-save').addEventListener('click', saveTranscript);
  $('#btn-copy').addEventListener('click', copyTranscript);
  $('#btn-new').addEventListener('click', newRecording);
  $('#btn-summarize').addEventListener('click', summarizeTranscript);

  // ── Backend download (first-run on fresh install) ──────────────────────
  window.murmur.onBackendMissing((missing) => {
    if (missing) {
      showView('download');
      btnRecord.disabled = true;
    }
  });

  window.murmur.onBackendDownloadProgress((data) => {
    const stageEl = $('#download-stage');
    const fillEl = $('#download-progress-fill');
    const detailEl = $('#download-detail');
    const pct = Math.round(data.percent || 0);

    fillEl.style.width = pct + '%';

    switch (data.stage) {
      case 'fetching-manifest':
        stageEl.textContent = 'Fetching download info...';
        break;
      case 'downloading':
        stageEl.textContent = `Downloading ML engine... ${pct}%`;
        break;
      case 'verifying':
        stageEl.textContent = 'Verifying...';
        break;
      case 'assembling':
        stageEl.textContent = 'Assembling archive...';
        break;
      case 'extracting':
        stageEl.textContent = 'Extracting ML engine — this may take a few minutes...';
        break;
      case 'done':
        stageEl.textContent = 'ML engine installed!';
        onBackendDownloadComplete();
        break;
      case 'error':
        stageEl.textContent = 'Download failed';
        $('#download-error').textContent = data.detail || 'Unknown error';
        $('#download-error').classList.remove('hidden');
        $('#btn-retry-download').classList.remove('hidden');
        break;
    }

    if (data.detail) detailEl.textContent = data.detail;
  });

  $('#btn-start-download').addEventListener('click', startBackendDownload);
  $('#btn-retry-download').addEventListener('click', startBackendDownload);

  // ── Onboarding (first-run) ───────────────────────────────────────────────
  if (!settings.vaultPath) {
    showOnboarding(models, settings);
  }
}

function updateModelBadge(key) {
  const m = models[key];
  if (m) {
    $('#model-badge').textContent = `${m.label} — ${m.params} params`;
  }
}

// ── View management ──────────────────────────────────────────────────────────
function showView(name) {
  Object.values(views).forEach(v => v.classList.remove('active'));
  views[name].classList.add('active');
}

// ── Recording ────────────────────────────────────────────────────────────────
async function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  try {
    if (mode === 'call') {
      detectedSourceApp = await window.murmur.detectSourceApp();
      await startCallRecording();
    } else {
      detectedSourceApp = null;
      await startMemoRecording();
    }

    // UI
    isRecording = true;
    btnRecord.classList.add('recording');
    btnRecord.innerHTML = '<span class="rec-dot"></span> Stop Recording';
    timerEl.classList.add('active');
    $('#recording-mode-tag').textContent = mode === 'call' ? 'CALL' : 'MEMO';
    $('#silence-hint').style.display = 'none';
    showView('recording');
    statusText.textContent = 'Recording…';

    // Reset live transcript
    liveTranscriptParts = [];
    const liveEl = document.getElementById('live-transcript');
    if (liveEl) liveEl.textContent = 'Listening...';

    startTime = Date.now();
    silenceStart = 0;
    timerInterval = setInterval(updateTimer, 200);

    drawWaveform();
    drawMeter();
    if (mode === 'memo') startLiveTranscription();

  } catch (err) {
    console.error('Failed to start recording:', err);
    statusText.textContent = err.name === 'NotAllowedError'
      ? 'Permission denied — check microphone/screen access'
      : `Error: ${err.message}`;
  }
}

async function startMemoRecording() {
  audioChunks = [];

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true }
  });

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  mediaRecorder = new MediaRecorder(mediaStream, { mimeType: pickMime() });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.onstop = () => processRecording();
  mediaRecorder.start(1000);

}

async function startCallRecording() {
  micChunks = [];
  sysChunks = [];

  // System audio via Electron's desktopCapturer loopback
  displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true
  });

  // Mic
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true }
  });

  audioContext = new AudioContext();

  // Don't stop video tracks — just disable them. Stopping kills audio.
  displayStream.getVideoTracks().forEach(t => { t.enabled = false; });

  // System audio track → its own recorder
  const sysAudioTracks = displayStream.getAudioTracks();
  if (sysAudioTracks.length > 0) {
    sysStream = new MediaStream(sysAudioTracks);
    sysRecorder = new MediaRecorder(sysStream, { mimeType: pickMime() });
    sysRecorder.ondataavailable = (e) => { if (e.data.size > 0) sysChunks.push(e.data); };
    sysRecorder.start(1000);
  }

  // Mic → its own recorder
  micRecorder = new MediaRecorder(micStream, { mimeType: pickMime() });
  micRecorder.ondataavailable = (e) => { if (e.data.size > 0) micChunks.push(e.data); };
  micRecorder.start(1000);

  // Merged analyser for visualization
  const destination = audioContext.createMediaStreamDestination();

  if (sysAudioTracks.length > 0) {
    const sysSource = audioContext.createMediaStreamSource(new MediaStream(sysAudioTracks));
    sysSource.connect(destination);
  }

  const micSource = audioContext.createMediaStreamSource(micStream);
  micSource.connect(destination);

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  const mergedSource = audioContext.createMediaStreamSource(destination.stream);
  mergedSource.connect(analyser);

}

async function stopRecording() {
  stopLiveTranscription();

  if (mode === 'call') {
    await stopCallRecording();
  } else {
    stopMemoRecording();
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
  }

  isRecording = false;
  btnRecord.classList.remove('recording');
  btnRecord.innerHTML = '<span class="rec-dot"></span> Start Recording';
  timerEl.classList.remove('active');
  clearInterval(timerInterval);
  cancelAnimationFrame(waveformAnim);
  cancelAnimationFrame(meterAnim);
}

function stopMemoRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
}

async function stopCallRecording() {
  // Stop recorders first, THEN tracks — stopping tracks early kills audio
  const recordersDone = [];

  if (micRecorder && micRecorder.state !== 'inactive') {
    recordersDone.push(new Promise(r => { micRecorder.onstop = r; micRecorder.stop(); }));
  }
  if (sysRecorder && sysRecorder.state !== 'inactive') {
    recordersDone.push(new Promise(r => { sysRecorder.onstop = r; sysRecorder.stop(); }));
  }

  // Wait for recorders to flush all data
  await Promise.all(recordersDone);

  // Now stop all tracks
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (sysStream) { sysStream.getTracks().forEach(t => t.stop()); sysStream = null; }
  if (displayStream) { displayStream.getTracks().forEach(t => t.stop()); displayStream = null; }

  // Process after everything is stopped
  processCallRecording();
}

// ── Timer & silence detection ────────────────────────────────────────────────
function updateTimer() {
  const elapsed = (Date.now() - startTime) / 1000;
  const m = Math.floor(elapsed / 60);
  const s = Math.floor(elapsed % 60);
  timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  if (!analyser) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const avg = data.reduce((a, b) => a + b, 0) / data.length;

  if (avg < 3) {
    if (!silenceStart) silenceStart = Date.now();
    const silenceSec = (Date.now() - silenceStart) / 1000;
    const remaining = Math.max(0, Math.ceil(silenceTimeout - silenceSec));

    if (remaining <= 30 && remaining > 0) {
      $('#silence-hint').style.display = '';
      $('#silence-countdown').textContent = remaining;
    }

    if (silenceSec > silenceTimeout) {
      statusText.textContent = 'Auto-stopped (silence detected)';
      stopRecording();
    }
  } else {
    silenceStart = 0;
    $('#silence-hint').style.display = 'none';
  }
}

// ── Waveform visualization ───────────────────────────────────────────────────
function drawWaveform() {
  const canvas = $('#waveform');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  function draw() {
    if (!analyser) return;
    waveformAnim = requestAnimationFrame(draw);

    const td = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(td);

    ctx.fillStyle = 'rgba(22, 22, 37, 0.3)';
    ctx.fillRect(0, 0, W, H);

    // Glow layer
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(108, 92, 231, 0.12)';
    ctx.beginPath();
    const sw = W / td.length;
    let x = 0;
    for (let i = 0; i < td.length; i++) {
      const y = (td[i] / 128.0) * H / 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      x += sw;
    }
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    // Main line
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#6c5ce7';
    ctx.beginPath();
    x = 0;
    for (let i = 0; i < td.length; i++) {
      const y = (td[i] / 128.0) * H / 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      x += sw;
    }
    ctx.lineTo(W, H / 2);
    ctx.stroke();
  }
  draw();
}

function drawMeter() {
  const canvas = $('#meter');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  function draw() {
    if (!analyser) { ctx.fillStyle = '#161625'; ctx.fillRect(0, 0, W, H); return; }
    meterAnim = requestAnimationFrame(draw);

    const d = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(d);

    ctx.fillStyle = '#161625';
    ctx.fillRect(0, 0, W, H);

    const bw = (W / d.length) * 2.5;
    let x = 0;
    for (let i = 0; i < d.length; i++) {
      const bh = (d[i] / 255) * H;
      ctx.fillStyle = `hsl(${258 - (d[i] / 255) * 30}, 60%, ${40 + (d[i] / 255) * 25}%)`;
      ctx.fillRect(x, H - bh, bw - 1, bh);
      x += bw;
      if (x > W) break;
    }
  }
  draw();
}

// ── Process memo recording (single channel) ──────────────────────────────────
async function processRecording() {
  showView('processing');
  $('#processing-status').textContent = 'Decoding audio…';

  try {
    const pcm = await decodeToPcm(audioChunks);
    const duration = pcm.length / 16000;

    $('#processing-status').textContent = 'Transcribing…';
    const result = await window.murmur.transcribe(pcm, 16000);

    lastTranscript = {
      text: result.text || '',
      chunks: result.chunks || [],
      duration,
      mode: 'memo',
      detectedLanguage: result.detectedLanguage || 'unknown'
    };

    renderTranscript(lastTranscript);
    showView('transcript');
    statusText.textContent = 'Transcription complete';
    window.murmur.notify('Murmur', 'Transcription complete — click to view');
  } catch (err) {
    console.error('Processing error:', err);
    statusText.textContent = `Error: ${err.message}`;
    showView('idle');
  }
}

// ── Process call recording (dual channel — speaker attribution) ──────────────
async function processCallRecording() {
  showView('processing');
  $('#processing-status').textContent = 'Decoding audio channels…';

  try {
    console.log(`[Call] micChunks: ${micChunks.length}, sysChunks: ${sysChunks.length}`);

    const [micPcm, sysPcm] = await Promise.all([
      decodeToPcm(micChunks),
      decodeToPcm(sysChunks)
    ]);

    console.log(`[Call] micPcm: ${micPcm.length} samples, sysPcm: ${sysPcm.length} samples`);

    if (micPcm.length === 0 && sysPcm.length === 0) {
      statusText.textContent = 'No audio captured';
      showView('idle');
      return;
    }

    const duration = Math.max(micPcm.length, sysPcm.length) / 16000;

    // If no system audio, fall back to memo-style transcription of mic only
    if (sysPcm.length === 0) {
      $('#processing-status').textContent = 'Transcribing mic audio…';
      const result = await window.murmur.transcribe(micPcm, 16000);

      lastTranscript = {
        text: result.text || '',
        chunks: (result.chunks || []).map(c => ({ ...c, speaker: 'You' })),
        duration,
        mode: 'call',
        detectedLanguage: result.detectedLanguage || 'unknown'
      };
    } else {
      $('#processing-status').textContent = 'Transcribing (dual channel)…';
      const result = await window.murmur.transcribeCall(micPcm, sysPcm, 16000);

      lastTranscript = {
        text: result.text || '',
        chunks: result.chunks || [],
        duration,
        mode: 'call',
        detectedLanguage: result.detectedLanguage || 'unknown'
      };
    }

    renderTranscript(lastTranscript);
    showView('transcript');
    statusText.textContent = 'Transcription complete';
    window.murmur.notify('Murmur', 'Transcription complete — click to view');
  } catch (err) {
    console.error('Call processing error:', err);
    statusText.textContent = `Error: ${err.message}`;
    showView('idle');
  }
}

// ── Decode audio chunks to 16kHz mono Float32Array ───────────────────────────
async function decodeToPcm(chunks) {
  if (!chunks || chunks.length === 0) return new Float32Array(0);

  const blob = new Blob(chunks, { type: 'audio/webm' });
  const arrayBuffer = await blob.arrayBuffer();

  // Decode
  const tmpCtx = new OfflineAudioContext(1, 1, 16000);
  const decoded = await tmpCtx.decodeAudioData(arrayBuffer);

  // Resample to 16kHz mono
  const targetRate = 16000;
  const outLength = Math.ceil(decoded.duration * targetRate);
  if (outLength <= 0) return new Float32Array(0);

  const offCtx = new OfflineAudioContext(1, outLength, targetRate);
  const src = offCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(offCtx.destination);
  src.start(0);

  const resampled = await offCtx.startRendering();
  return resampled.getChannelData(0);
}

// ── Render transcript ────────────────────────────────────────────────────────
function renderTranscript({ text, chunks, duration, mode: tMode, detectedLanguage }) {
  // Meta chips
  const dMin = Math.floor(duration / 60);
  const dSec = Math.round(duration % 60);
  $('#meta-duration').textContent = `${dMin}m ${dSec}s`;
  const langName = languages[detectedLanguage] || detectedLanguage || 'Unknown';
  $('#meta-language').textContent = langName;
  $('#meta-mode').textContent = tMode === 'call' ? 'Call Capture' : 'Voice Memo';

  const container = $('#transcript-content');
  container.innerHTML = '';

  if (chunks && chunks.length > 0) {
    chunks.forEach(chunk => {
      const div = document.createElement('div');
      div.className = 'chunk';

      let html = '';
      if (chunk.timestamp && chunk.timestamp[0] !== undefined) {
        html += `<span class="timestamp">[${fmtTs(chunk.timestamp[0])}]</span>`;
      }
      if (chunk.speaker) {
        html += `<span class="speaker ${speakerClass(chunk.speaker)}">${escapeHtml(chunk.speaker)}</span>`;
      }
      html += escapeHtml(chunk.text.trim());
      div.innerHTML = html;
      container.appendChild(div);
    });
  } else if (text) {
    const div = document.createElement('div');
    div.className = 'chunk';
    div.textContent = text;
    container.appendChild(div);
  } else {
    const div = document.createElement('div');
    div.className = 'chunk';
    div.style.color = 'var(--text-muted)';
    div.textContent = 'No speech detected.';
    container.appendChild(div);
  }
}

// ── Summarize ────────────────────────────────────────────────────────────────
async function summarizeTranscript() {
  if (!lastTranscript) return;

  const btn = $('#btn-summarize');
  btn.disabled = true;
  btn.textContent = 'Summarizing…';

  try {
    // Build text with speaker labels so the LLM knows who said what
    let text = '';
    if (lastTranscript.chunks && lastTranscript.chunks.length > 0) {
      text = lastTranscript.chunks.map(c => {
        const speaker = c.speaker ? `${c.speaker}: ` : '';
        return speaker + c.text.trim();
      }).join('\n');
    } else {
      text = lastTranscript.text;
    }

    const result = await window.murmur.summarize(text);
    $('#summary-section').classList.remove('hidden');
    $('#summary-content').innerHTML = renderMarkdown(result.summary);
    lastTranscript.summary = result.summary;
  } catch (err) {
    console.error('Summarization error:', err);
    statusText.textContent = `Summarization error: ${err.message}`;
  }

  btn.disabled = false;
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="15" y1="14" x2="3" y2="14"/><line x1="15" y1="18" x2="3" y2="18"/></svg> Summarize';
}

// Minimal markdown renderer for summary output (bold, bullets, headings)
function renderMarkdown(md) {
  return escapeHtml(md)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 style="margin:12px 0 6px;font-size:14px;color:var(--accent)">$1</h3>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul style="margin:4px 0 8px 16px;list-style:disc">$&</ul>')
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

// ── Save ─────────────────────────────────────────────────────────────────────
async function saveTranscript() {
  if (!lastTranscript) return;

  const saveData = {
    mode: lastTranscript.mode,
    transcript: lastTranscript.text,
    chunks: lastTranscript.chunks,
    duration: lastTranscript.duration,
    sourceApp: lastTranscript.mode === 'call' ? (detectedSourceApp || 'Screen Capture') : 'Microphone',
    detectedLanguage: lastTranscript.detectedLanguage
  };
  if (lastTranscript.summary) {
    saveData.summary = lastTranscript.summary;
  }

  const result = await window.murmur.saveTranscript(saveData);

  if (result.success) {
    statusText.textContent = `Saved → ${result.filePath}`;
    $('#btn-save').textContent = 'Saved!';
    $('#btn-save').disabled = true;
    setTimeout(() => window.murmur.openFile(result.filePath), 300);
  } else {
    statusText.textContent = result.error || 'Failed to save';
  }
}

async function copyTranscript() {
  if (!lastTranscript) return;

  let text = '';
  if (lastTranscript.chunks && lastTranscript.chunks.length > 0) {
    text = lastTranscript.chunks.map(c => {
      const ts = c.timestamp?.[0] !== undefined ? `[${fmtTs(c.timestamp[0])}] ` : '';
      const sp = c.speaker ? `${c.speaker}: ` : '';
      return ts + sp + c.text.trim();
    }).join('\n');
  } else {
    text = lastTranscript.text;
  }

  await navigator.clipboard.writeText(text);
  $('#btn-copy').textContent = 'Copied!';
  setTimeout(() => { $('#btn-copy').textContent = 'Copy Text'; }, 2000);
}

function newRecording() {
  lastTranscript = null;
  $('#summary-section').classList.add('hidden');
  $('#summary-content').textContent = '';
  showView('idle');
  timerEl.textContent = '00:00';
  statusText.textContent = 'Ready';
  const saveBtn = $('#btn-save');
  saveBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save to Vault`;
  saveBtn.disabled = false;
}

// ── Settings modal ───────────────────────────────────────────────────────────
async function openSettings() {
  const settings = await window.murmur.getSettings();
  $('#setting-vault').value = settings.vaultPath || '';
  $('#setting-subfolder').value = settings.vaultSubfolder || 'Murmur';
  $('#setting-silence').value = settings.silenceTimeout || 120;
  $('#setting-model').value = settings.modelSize || 'base';
  $('#setting-language').value = settings.language || 'auto';
  $('#setting-hide-screenshare').checked = settings.hideFromScreenShare !== false;
  $('#setting-summary-model').value = settings.summaryModel || 'qwen2.5-3b';
  $('#settings-modal').classList.remove('hidden');
}

function closeSettings() {
  $('#settings-modal').classList.add('hidden');
}


// ── Live transcription ──────────────────────────────────────────────────────
function startLiveTranscription() {
  // Transcribe every 5 seconds using accumulated audio
  liveInterval = setInterval(async () => {
    if (isTranscribingLive) return; // skip if previous chunk still processing

    // Get current chunks based on mode
    const chunks = mode === 'call' ? micChunks : audioChunks;
    if (!chunks || chunks.length < 3) return;

    isTranscribingLive = true;
    try {
      const blob = new Blob([...chunks], { type: 'audio/webm' });
      const pcm = await decodeToPcm([blob]);
      if (pcm.length < 16000) { isTranscribingLive = false; return; }

      // Only send last 30 seconds to keep it fast
      const maxSamples = 30 * 16000;
      const segment = pcm.length > maxSamples
        ? pcm.slice(pcm.length - maxSamples)
        : pcm;

      const result = await window.murmur.transcribeStream(segment, 16000);
      if (result.text) {
        const liveEl = document.getElementById('live-transcript');
        if (liveEl) {
          liveEl.textContent = result.text;
          liveEl.scrollTop = liveEl.scrollHeight;
        }
      }
    } catch (e) {
      console.warn('Live transcription error:', e);
    }
    isTranscribingLive = false;
  }, 5000);
}

function stopLiveTranscription() {
  if (liveInterval) {
    clearInterval(liveInterval);
    liveInterval = null;
  }
  isTranscribingLive = false;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtTs(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function speakerClass(name) {
  if (name === 'You') return 'speaker-you';
  const m = name.match(/Speaker (\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    return n >= 2 && n <= 6 ? `speaker-${n}` : 'speaker-other';
  }
  return 'speaker-other';
}

function pickMime() {
  return MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
}

// ── Onboarding wizard ───────────────────────────────────────────────────────
function showOnboarding(modelList, currentSettings) {
  const modal = $('#onboarding-modal');
  const dots = modal.querySelectorAll('.step-dot');
  const steps = modal.querySelectorAll('.onboarding-step');
  let currentStep = 1;

  // Populate onboarding model dropdown
  const onboardModelSelect = $('#onboarding-model');
  onboardModelSelect.innerHTML = '';
  for (const [key, m] of Object.entries(modelList)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${m.label} — ${m.size} (${m.params} params)`;
    if (key === (currentSettings.modelSize || 'tiny')) opt.selected = true;
    onboardModelSelect.appendChild(opt);
  }

  function goToStep(step) {
    currentStep = step;
    steps.forEach(s => s.classList.remove('active'));
    dots.forEach(d => {
      d.classList.remove('active', 'completed');
      const dStep = parseInt(d.dataset.step, 10);
      if (dStep === step) d.classList.add('active');
      else if (dStep < step) d.classList.add('completed');
    });
    modal.querySelector(`.onboarding-step[data-step="${step}"]`).classList.add('active');
  }

  // Step 1 → Step 2
  $('#onboarding-start').addEventListener('click', () => goToStep(2));

  // Step 2: Browse vault
  const vaultInput = $('#onboarding-vault-path');
  const nextBtn = $('#onboarding-next');

  $('#onboarding-browse').addEventListener('click', async () => {
    const folder = await window.murmur.pickFolder();
    if (folder) {
      vaultInput.value = folder;
      window.murmur.setSetting('vaultPath', folder);
      $('#setting-vault').value = folder;
      nextBtn.disabled = false;
    }
  });

  // Step 2 → Step 3
  nextBtn.addEventListener('click', () => {
    if (!nextBtn.disabled) goToStep(3);
  });

  // Step 3: Model selection
  onboardModelSelect.addEventListener('change', (e) => {
    window.murmur.setSetting('modelSize', e.target.value);
    updateModelBadge(e.target.value);
    $('#setting-model').value = e.target.value;
  });

  // Finish
  $('#onboarding-finish').addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  // Show modal
  modal.classList.remove('hidden');
}

// ── Backend download ────────────────────────────────────────────────────────
async function startBackendDownload() {
  $('#btn-start-download').classList.add('hidden');
  $('#btn-retry-download').classList.add('hidden');
  $('#download-error').classList.add('hidden');
  $('#download-progress-section').classList.remove('hidden');
  $('#download-stage').textContent = 'Starting download...';
  $('#download-progress-fill').style.width = '0%';
  $('#download-detail').textContent = '';

  const result = await window.murmur.startBackendDownload();
  if (!result.success) {
    $('#download-error').textContent = `Download failed: ${result.error}`;
    $('#download-error').classList.remove('hidden');
    $('#btn-retry-download').classList.remove('hidden');
  }
}

async function onBackendDownloadComplete() {
  await new Promise(r => setTimeout(r, 1500));

  const launched = await window.murmur.launchBackendAfterDownload();
  if (launched) {
    btnRecord.disabled = false;
    showView('idle');
    statusText.textContent = 'ML backend starting...';
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
init();
