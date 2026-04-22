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


def suppress_echo(mic_pcm, sys_pcm, sample_rate, window_ms=300):
    """Suppress mic audio that is just echo/bleed from system speakers.

    Uses three signals to detect echo:
      1. Absolute mic floor — mic energy too low to be real speech
      2. Energy ratio — system audio significantly louder than mic
      3. Cross-correlation — mic waveform correlates with system (echo)

    Only keeps mic audio when the user is clearly speaking (high energy,
    uncorrelated with system audio).
    """
    mic = mic_pcm.copy()
    window = int(sample_rate * window_ms / 1000)

    if len(mic) == 0 or len(sys_pcm) == 0:
        return mic

    # Pad/trim sys to match mic length
    sys = sys_pcm
    if len(sys) < len(mic):
        sys = np.pad(sys, (0, len(mic) - len(sys)))
    elif len(sys) > len(mic):
        sys = sys[:len(mic)]

    # Compute global mic RMS to set adaptive floor
    global_mic_rms = np.sqrt(np.mean(mic ** 2))
    # Adaptive floor: at least 0.015, or 1.5x the global mic RMS
    # (if user is muted entire time, global RMS is just bleed level)
    mic_floor = max(0.015, global_mic_rms * 1.5)

    n_windows = len(mic) // window
    suppressed = 0

    for i in range(n_windows):
        start = i * window
        end = start + window

        mic_win = mic[start:end]
        sys_win = sys[start:end]

        mic_rms = np.sqrt(np.mean(mic_win ** 2))
        sys_rms = np.sqrt(np.mean(sys_win ** 2))

        # 1. Mic too quiet — definitely not real speech
        if mic_rms < mic_floor:
            mic[start:end] = 0.0
            suppressed += 1
            continue

        # 2. System audio active and louder than mic — likely echo
        if sys_rms > 0.005 and sys_rms > mic_rms * 0.8:
            mic[start:end] = 0.0
            suppressed += 1
            continue

        # 3. High correlation — mic is echoing system audio
        if sys_rms > 0.005 and mic_rms > 0:
            # Normalize and compute correlation
            mic_norm = mic_win - np.mean(mic_win)
            sys_norm = sys_win - np.mean(sys_win)
            mic_std = np.std(mic_norm)
            sys_std = np.std(sys_norm)
            if mic_std > 1e-8 and sys_std > 1e-8:
                corr = np.dot(mic_norm, sys_norm) / (mic_std * sys_std * len(mic_win))
                if abs(corr) > 0.3:  # Moderate correlation = echo
                    mic[start:end] = 0.0
                    suppressed += 1
                    continue

    total = max(n_windows, 1)
    pct = 100 * suppressed / total
    print(f"[Murmur] Echo suppression: zeroed {suppressed}/{total} windows ({pct:.0f}%) | mic_floor={mic_floor:.4f}")

    return mic
