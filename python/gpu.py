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


def compute_type_for_device(device):
    """Pick optimal compute type for faster-whisper."""
    if device == "cuda":
        return "float16"
    return "int8"
