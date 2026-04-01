"""Whisper transcription via faster-whisper (CTranslate2)."""
from faster_whisper import WhisperModel
from gpu import detect_device, compute_type_for_device

_model = None
_current_size = None


def load(model_size="base", on_progress=None):
    """Load or switch the Whisper model."""
    global _model, _current_size

    if _model and _current_size == model_size:
        return

    device = detect_device()
    ct = compute_type_for_device(device)

    if on_progress:
        on_progress(f"Loading Whisper {model_size} on {device.upper()} ({ct})...")

    _model = WhisperModel(model_size, device=device, compute_type=ct)
    _current_size = model_size

    if on_progress:
        on_progress(f"Whisper {model_size} ready on {device.upper()}")


def transcribe(pcm, sample_rate=16000, language=None, on_progress=None):
    """Transcribe audio. Returns dict with text, chunks, detectedLanguage."""
    if _model is None:
        raise RuntimeError("Model not loaded")

    if on_progress:
        on_progress("Transcribing...")

    kwargs = {
        "beam_size": 5,
        "vad_filter": True,
        "vad_parameters": {"min_silence_duration_ms": 500},
    }
    if language and language != "auto":
        kwargs["language"] = language

    segments, info = _model.transcribe(pcm, **kwargs)

    chunks = []
    full_text_parts = []
    for seg in segments:
        chunk = {
            "text": seg.text,
            "timestamp": [round(seg.start, 2), round(seg.end, 2)],
        }
        chunks.append(chunk)
        full_text_parts.append(seg.text.strip())

    return {
        "text": " ".join(full_text_parts),
        "chunks": chunks,
        "detectedLanguage": info.language if info else "unknown",
    }


def unload():
    """Free the model from memory."""
    global _model, _current_size
    _model = None
    _current_size = None
