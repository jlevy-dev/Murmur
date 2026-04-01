const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('murmur', {
  // Constants
  getModels: () => ipcRenderer.invoke('get-models'),
  getLanguages: () => ipcRenderer.invoke('get-languages'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  setCompute: (value) => ipcRenderer.invoke('settings:setCompute', value),
  pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),

  // Transcription — single channel (memo)
  transcribe: (audioFloat32, sampleRate) =>
    ipcRenderer.invoke('transcribe', Array.from(audioFloat32), sampleRate),

  // Transcription — live stream (lightweight, during recording)
  transcribeStream: (audioFloat32, sampleRate) =>
    ipcRenderer.invoke('transcribe-stream', Array.from(audioFloat32), sampleRate),

  // Transcription — dual channel (call: mic + system)
  transcribeCall: (micFloat32, sysFloat32, sampleRate) =>
    ipcRenderer.invoke('transcribe-call', Array.from(micFloat32), Array.from(sysFloat32), sampleRate),

  // Summarization
  getSummaryModels: () => ipcRenderer.invoke('get-summary-models'),
  summarize: (text) => ipcRenderer.invoke('summarize', text),

  // Detection
  detectSourceApp: () => ipcRenderer.invoke('detect-source-app'),

  // Save
  saveTranscript: (data) => ipcRenderer.invoke('save-transcript', data),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),

  // Events from main process
  onStatus: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('status', handler);
    return () => ipcRenderer.removeListener('status', handler);
  },
  onModelProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('model-progress', handler);
    return () => ipcRenderer.removeListener('model-progress', handler);
  },
  onToggleRecording: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('toggle-recording', handler);
    return () => ipcRenderer.removeListener('toggle-recording', handler);
  }
});
