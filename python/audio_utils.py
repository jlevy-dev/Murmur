"""Audio utility functions — base64 decode, silence trimming."""
import base64
import struct
import numpy as np


def decode_base64_pcm(b64_string):
    """Decode base64-encoded Float32 PCM to numpy array."""
    raw = base64.b64decode(b64_string)
    return np.frombuffer(raw, dtype=np.float32)


def encode_float32_to_base64(arr):
    """Encode numpy float32 array to base64 string."""
    return base64.b64encode(arr.astype(np.float32).tobytes()).decode("ascii")


def trim_silence(pcm, sample_rate, threshold=0.01, min_silence_ms=300):
    """Remove leading/trailing silence and collapse long internal silences."""
    frame_size = int(sample_rate * min_silence_ms / 1000)
    if len(pcm) < frame_size:
        return pcm

    # Compute per-frame RMS
    n_frames = len(pcm) // frame_size
    frames = pcm[:n_frames * frame_size].reshape(n_frames, frame_size)
    rms = np.sqrt(np.mean(frames ** 2, axis=1))

    # Find voiced frames
    voiced = rms > threshold
    if not np.any(voiced):
        return pcm[:0]  # All silence

    # Keep voiced frames plus one frame of context on each side
    result_frames = []
    for i in range(n_frames):
        if voiced[i]:
            result_frames.append(frames[i])
        elif (i > 0 and voiced[i - 1]) or (i < n_frames - 1 and voiced[i + 1]):
            result_frames.append(frames[i])

    if not result_frames:
        return pcm[:0]

    return np.concatenate(result_frames)
