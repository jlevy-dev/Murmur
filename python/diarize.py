"""Speaker diarization using speechbrain ECAPA-TDNN embeddings + clustering."""
import numpy as np
import torch
from scipy.cluster.hierarchy import linkage, fcluster
from scipy.spatial.distance import cosine

_classifier = None


def load(on_progress=None):
    """Load the speaker embedding model."""
    global _classifier
    if _classifier is not None:
        return

    if on_progress:
        on_progress("Loading speaker embedding model...")

    from speechbrain.inference.speaker import SpeakerRecognition
    _classifier = SpeakerRecognition.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir="models/spkrec-ecapa",
    )

    if on_progress:
        on_progress("Speaker model ready")


def diarize(pcm, sample_rate, chunks, on_progress=None):
    """Assign speaker labels to transcription chunks.

    Args:
        pcm: System audio as numpy float32 array
        sample_rate: Sample rate (16000)
        chunks: List of dicts with 'text' and 'timestamp' [start, end]
        on_progress: Callback for status updates

    Returns:
        chunks with 'speaker' field added ("Speaker 2", "Speaker 3", ...)
    """
    if not chunks or len(chunks) < 2:
        return [dict(c, speaker="Speaker 2") for c in (chunks or [])]

    load(on_progress)

    # Extract embeddings for each chunk
    embeddings = []
    valid_indices = []

    for i, chunk in enumerate(chunks):
        if on_progress:
            on_progress(f"Diarizing... segment {i + 1}/{len(chunks)}")

        start, end = chunk.get("timestamp", [0, 0])
        s0 = int(start * sample_rate)
        s1 = min(int(end * sample_rate), len(pcm))
        segment = pcm[s0:s1]

        # Skip very short segments (< 0.5s)
        if len(segment) < sample_rate * 0.5:
            embeddings.append(None)
            continue

        try:
            waveform = torch.tensor(segment).unsqueeze(0)
            emb = _classifier.encode_batch(waveform).squeeze().cpu().numpy()
            embeddings.append(emb)
            valid_indices.append(i)
        except Exception:
            embeddings.append(None)

    # Cluster valid embeddings
    valid_embs = [embeddings[i] for i in valid_indices]
    if len(valid_embs) < 2:
        return [dict(c, speaker="Speaker 2") for c in chunks]

    emb_matrix = np.stack(valid_embs)

    # Agglomerative clustering with cosine distance
    Z = linkage(emb_matrix, method="average", metric="cosine")
    labels = fcluster(Z, t=0.5, criterion="distance")

    # Map cluster IDs to speaker names
    label_map = {}
    next_id = 2
    result = []
    label_idx = 0

    for i, chunk in enumerate(chunks):
        if i in valid_indices:
            cluster = labels[label_idx]
            if cluster not in label_map:
                label_map[cluster] = f"Speaker {next_id}"
                next_id += 1
            result.append(dict(chunk, speaker=label_map[cluster]))
            label_idx += 1
        else:
            result.append(dict(chunk, speaker="Speaker 2"))

    return result


def unload():
    """Free the model from memory."""
    global _classifier
    _classifier = None
