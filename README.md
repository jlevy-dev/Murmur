<h1 align="center">Murmur</h1>

<p align="center">
  <strong>Local meeting capture → Obsidian vault → AI agent pipeline. No cloud. No API keys. Your data.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-35-47848F?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/Windows-10%2B-0078D6?logo=windows&logoColor=white" alt="Windows 10+" />
  <img src="https://img.shields.io/badge/Python-3.12%2B-3776AB?logo=python&logoColor=white" alt="Python 3.12+" />
  <img src="https://img.shields.io/badge/CUDA-RTX%20GPU-76B900?logo=nvidia&logoColor=white" alt="NVIDIA CUDA" />
  <img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT License" />
</p>

---

Murmur is a **Windows refactor of [Tome](https://github.com/Gremble-io/Tome)**, the macOS Swift app for local meeting capture. Same idea, rebuilt from scratch as an Electron + Python app to run on Windows with NVIDIA GPU acceleration.

Everything runs on-device. Captures meetings and voice memos, transcribes them locally with faster-whisper, diarizes speakers with speechbrain, summarizes with Qwen2.5, and drops structured `.md` files straight into your Obsidian vault.

## Why Murmur?

Tome was macOS-only, Apple Silicon-only. Murmur brings the same workflow to Windows:

- **Plain markdown out.** YAML frontmatter, tags, timestamps. Your vault already knows what to do with it.
- **Built for the agent pipeline.** Murmur is just the capture layer. You talk, it transcribes, your agent picks up the `.md` and does the rest.
- **Runs on your machine.** faster-whisper + CUDA on your RTX GPU. No API keys, no accounts, no subscriptions, no data leaving the building.
- **Better models.** Whisper large-v3 for transcription, speechbrain ECAPA-TDNN for speaker embeddings, Qwen2.5 for summarization. All local.

```
speak → capture → vault → agent → knowledge base
```

## Features

- **Multilingual transcription** via [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2) on CUDA. Models from tiny to large-v3. Auto language detection.
- **Call Capture** grabs mic + system audio via Electron's desktopCapturer. Detects which conferencing app you're in (Teams, Zoom, Slack, Discord).
- **Voice Memo** is mic only. Quick thoughts, verbal notes, stream of consciousness.
- **Live transcription** during voice memos — see your words appear in real-time as you speak.
- **Speaker diarization** via [speechbrain](https://github.com/speechbrain/speechbrain) ECAPA-TDNN embeddings + agglomerative clustering. Splits remote audio into Speaker 2, Speaker 3, etc.
- **Local summarization** with Qwen2.5 (1.5B/3B) or Phi-3.5 Mini. Generates summary, key points, and action items.
- **Vault-native output** writes `.md` with frontmatter: `type`, `created`, `attendees`, `tags`, `source_app`.
- **Privacy.** Hidden from screen sharing by default. No audio saved. Transcripts only.
- **Silence auto-stop.** Configurable dead air timeout.
- **Model preloading.** Models load on startup so your first transcription is instant.

## Architecture

Murmur runs as two processes:

```
┌─────────────────────────────────┐     ┌──────────────────────────────┐
│  Electron (UI + Audio Capture)  │     │  Python Backend (ML)         │
│                                 │     │                              │
│  ┌──────────┐  ┌─────────────┐  │ WS  │  ┌────────────────────────┐  │
│  │ Renderer │  │ Main Process│◀─┼─────┼─▶│ WebSocket Server :9735 │  │
│  │ (UI)     │  │ (IPC bridge)│  │     │  └────────┬───────────────┘  │
│  └──────────┘  └─────────────┘  │     │           │                  │
│                                 │     │  ┌────────▼───────────────┐  │
│  Audio: MediaRecorder +         │     │  │ faster-whisper (CUDA)  │  │
│  Web Audio API +                │     │  │ speechbrain (diarize)  │  │
│  desktopCapturer (sys audio)    │     │  │ Qwen2.5 (summarize)   │  │
└─────────────────────────────────┘     │  └────────────────────────┘  │
                                        └──────────────────────────────┘
                                                     │
                                                     ▼
                                        ┌──────────────────────┐
                                        │  Obsidian Vault      │
                                        │  (.md with YAML)     │
                                        └──────────────────────┘
```

- **Electron** handles the UI, audio capture, and acts as a WebSocket client
- **Python** runs on `localhost:9735` as the ML backend, handling all inference
- Audio is transferred as base64-encoded Float32 PCM over WebSocket

## Project Structure

```
├── main.js                  # Electron main process + WebSocket client
├── preload.js               # IPC bridge (contextBridge)
├── renderer/
│   ├── index.html           # UI markup
│   ├── app.js               # UI logic, recording, live transcription
│   └── styles.css           # Dark theme styles
├── python/
│   ├── server.py            # WebSocket ML server (asyncio)
│   ├── transcribe.py        # faster-whisper wrapper
│   ├── diarize.py           # speechbrain speaker diarization
│   ├── summarize.py         # Qwen2.5 / Phi-3.5 summarization
│   ├── gpu.py               # CUDA detection + VRAM info
│   ├── audio_utils.py       # PCM decoding + silence trimming
│   ├── build.py             # PyInstaller build script
│   └── requirements.txt     # Python dependencies
└── package.json             # Electron + electron-builder config
```

## Models

| Component | Model | Size | GPU |
|---|---|---|---|
| **Transcription** | faster-whisper (tiny → large-v3) | 75 MB → 3 GB | CUDA float16 |
| **Diarization** | speechbrain ECAPA-TDNN (spkrec-ecapa-voxceleb) | ~100 MB | CUDA |
| **Summarization** | Qwen2.5-1.5B / 3B / Phi-3.5 Mini | 1.2 → 2.8 GB | CUDA float16 |

Models are downloaded automatically on first use and cached locally.

## Requirements

- **Windows 10+**
- **NVIDIA GPU** with CUDA support (RTX series recommended, 8GB+ VRAM)
- **Python 3.12+** (for development)
- **Node.js 18+** (for development)

Falls back to CPU if no CUDA GPU is available, but transcription will be significantly slower.

## Setup (Development)

```bash
# Clone
git clone https://github.com/jlevy-dev/Murmur.git
cd Murmur

# Install Node dependencies
npm install

# Install Python dependencies (use CUDA 12.8 wheels)
cd python
pip install -r requirements.txt
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
cd ..

# Run
npm start
```

## Build (Portable Distribution)

```bash
# Build Python backend as standalone exe
npm run build:python

# Build Electron app (outputs to dist/win-unpacked/)
npx electron-builder --win

# Distribute the entire dist/win-unpacked/ folder
# Users run Murmur.exe directly — no installation needed
```

The built app is ~5 GB (includes PyTorch + CUDA runtime + all ML dependencies).

## Output

```markdown
---
type: meeting
created: 2026-04-01T14:30:00.000Z
time: "14:30:00"
duration: "12m 45s"
source_app: "Microsoft Teams"
language: "English"
attendees:
  - "You"
  - "Speaker 2"
  - "Speaker 3"
tags:
  - log/meeting
  - status/inbox
  - source/murmur
---

# Meeting Transcript

## Summary

- Discussed Q2 roadmap priorities and timeline
- Agreed to move launch date to April 15th

**Key Points:**
- Feature freeze is next Friday
- QA needs two more days for regression testing

**Action Items:**
- [ ] Update project timeline in Notion
- [ ] Schedule follow-up with design team

## Full Transcript

[00:00] **You:** Morning. Quick sync on the launch timeline.

[00:03] **Speaker 2:** We're in good shape. QA signed off on the core flows yesterday.

[00:08] **Speaker 3:** I still need two more days for regression on the API changes.
```

## Privacy

- All transcription, diarization, and summarization runs on-device
- No network calls. No analytics. No telemetry
- No audio is saved to disk — only text transcripts
- The app window is hidden from screen sharing by default
- Transcripts are saved as plain `.md` files to a folder you choose

## Tome → Murmur

Murmur is a Windows refactor of [Tome](https://github.com/Gremble-io/Tome), the original macOS Swift app. Same philosophy, different stack:

| | Tome (macOS) | Murmur (Windows) |
|---|---|---|
| **Runtime** | Swift / SwiftUI | Electron / Node.js |
| **Transcription** | Parakeet-TDT v3 (CoreML/ANE) | faster-whisper (CUDA) |
| **Diarization** | pyannote | speechbrain ECAPA-TDNN |
| **Summarization** | — | Qwen2.5 / Phi-3.5 (local) |
| **Audio Capture** | ScreenCaptureKit | desktopCapturer + Web Audio API |
| **GPU** | Apple Silicon (Metal/ANE) | NVIDIA CUDA |

Same idea: local-first, privacy-focused, vault-native output. Different platform, different tools.

## Credits

- [Tome](https://github.com/Gremble-io/Tome) — the original macOS app this was refactored from
- [OpenGranola](https://github.com/yazinsai/OpenGranola) — the project that inspired Tome
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — CTranslate2 Whisper implementation
- [speechbrain](https://github.com/speechbrain/speechbrain) — speaker recognition toolkit
- [Qwen2.5](https://github.com/QwenLM/Qwen2.5) — local language model for summarization

## License

[MIT](LICENSE)
