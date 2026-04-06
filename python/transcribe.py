"""Speech transcription via NVIDIA Parakeet TDT v3 (NeMo)."""
import torch
import numpy as np
from gpu import detect_device

_model = None
_current_model_name = None

MODELS = {
    "parakeet-tdt-0.6b": {
        "id": "nvidia/parakeet-tdt-0.6b-v3",
        "label": "Parakeet TDT 0.6B",
        "size": "~700 MB",
        "params": "600M",
    },
    "parakeet-tdt-1.1b": {
        "id": "nvidia/parakeet-tdt_ctc-1.1b",
        "label": "Parakeet TDT 1.1B",
        "size": "~1.3 GB",
        "params": "1.1B",
    },
}

DEFAULT_MODEL = "parakeet-tdt-0.6b"


def load(model_size=DEFAULT_MODEL, on_progress=None):
    """Load or switch the Parakeet model."""
    global _model, _current_model_name
    import nemo.collections.asr as nemo_asr

    # Map legacy whisper model names to parakeet default
    if model_size in ("tiny", "base", "small", "medium", "large-v3"):
        model_size = DEFAULT_MODEL

    if _model and _current_model_name == model_size:
        return

    model_info = MODELS.get(model_size, MODELS[DEFAULT_MODEL])
    model_id = model_info["id"]
    device = detect_device()

    if on_progress:
        on_progress(f"Loading {model_info['label']} on {device.upper()}...")

    _model = nemo_asr.models.ASRModel.from_pretrained(model_name=model_id)

    if device == "cuda":
        _model = _model.cuda()
        _model = _model.to(torch.float16)

    _model.eval()
    _current_model_name = model_size

    if on_progress:
        on_progress(f"{model_info['label']} ready on {device.upper()}")


def transcribe(pcm, sample_rate=16000, language=None, on_progress=None):
    """Transcribe audio. Returns dict with text, chunks, detectedLanguage."""
    if _model is None:
        raise RuntimeError("Model not loaded")

    if on_progress:
        on_progress("Transcribing...")

    # Resample to 16kHz if needed
    if sample_rate != 16000:
        import torchaudio
        pcm_tensor = torch.from_numpy(pcm).unsqueeze(0)
        pcm_tensor = torchaudio.functional.resample(pcm_tensor, sample_rate, 16000)
        pcm = pcm_tensor.squeeze(0).numpy()

    # NeMo expects a list of numpy arrays or file paths
    output = _model.transcribe(
        [pcm],
        timestamps=True,
        return_hypotheses=True,
        batch_size=1,
    )

    # Extract hypothesis — output format varies by NeMo version
    if isinstance(output, tuple):
        hyp = output[0][0]
    elif isinstance(output, list):
        hyp = output[0]
    else:
        hyp = output

    full_text = hyp.text if hasattr(hyp, "text") else str(hyp)

    # Extract segment timestamps
    chunks = []
    if hasattr(hyp, "timestamp") and hyp.timestamp:
        ts = hyp.timestamp
        # Prefer segment-level timestamps
        segments = ts.get("segment", ts.get("word", []))
        for seg in segments:
            text = seg.get("segment", seg.get("text", seg.get("char", "")))
            chunks.append({
                "text": text,
                "timestamp": [round(seg.get("start", 0), 2), round(seg.get("end", 0), 2)],
            })

    if not chunks and full_text:
        # Fallback: single chunk with no timestamp
        chunks = [{"text": full_text, "timestamp": [0, 0]}]

    # Language detection — Parakeet v3 supports 25 languages but doesn't expose detection
    detected_lang = "en"
    if full_text:
        try:
            from langdetect import detect
            detected_lang = detect(full_text)
        except Exception:
            detected_lang = "unknown"

    return {
        "text": full_text,
        "chunks": chunks,
        "detectedLanguage": detected_lang,
    }


def get_models():
    """Return available transcription models for the UI."""
    return MODELS


def unload():
    """Free the model from memory."""
    global _model, _current_model_name
    if _model is not None:
        del _model
        _model = None
    _current_model_name = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
