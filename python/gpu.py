"""GPU detection and VRAM management."""
import torch


def detect_device():
    """Return 'cuda' if available, else 'cpu'."""
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def gpu_info():
    """Return GPU info dict for reporting to the frontend."""
    if not torch.cuda.is_available():
        return {"available": False, "device": "cpu"}

    props = torch.cuda.get_device_properties(0)
    free, total = torch.cuda.mem_get_info(0)
    return {
        "available": True,
        "device": "cuda",
        "name": props.name,
        "vram_total_mb": total // (1024 * 1024),
        "vram_free_mb": free // (1024 * 1024),
    }


def recommend_models(vram_mb):
    """Return recommended transcription and summary models based on available VRAM.

    Returns a dict with 'transcription_model', 'summary_model' (None if insufficient),
    and 'tier' describing the VRAM bracket.
    """
    if vram_mb < 4096:
        return {
            "transcription_model": "parakeet-tdt-0.6b",
            "summary_model": None,
            "tier": "low",
            "tier_label": f"<4 GB VRAM ({vram_mb} MB available)",
        }
    elif vram_mb < 8192:
        return {
            "transcription_model": "parakeet-tdt-0.6b",
            "summary_model": "qwen2.5-1.5b",
            "tier": "medium",
            "tier_label": f"4-8 GB VRAM ({vram_mb} MB available)",
        }
    else:
        return {
            "transcription_model": "parakeet-tdt-1.1b",
            "summary_model": "qwen2.5-3b",
            "tier": "high",
            "tier_label": f"8+ GB VRAM ({vram_mb} MB available)",
        }
