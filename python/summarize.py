"""Local summarization using transformers."""
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from gpu import detect_device

_model = None
_tokenizer = None
_current_model_id = None

SUMMARY_MODELS = {
    "qwen2.5-1.5b": {
        "id": "Qwen/Qwen2.5-1.5B-Instruct",
        "label": "Qwen2.5 1.5B",
        "size": "~1.2 GB",
        "params": "1.5B",
    },
    "qwen2.5-3b": {
        "id": "Qwen/Qwen2.5-3B-Instruct",
        "label": "Qwen2.5 3B",
        "size": "~2.4 GB",
        "params": "3B",
    },
    "phi-3.5-mini": {
        "id": "microsoft/Phi-3.5-mini-instruct",
        "label": "Phi 3.5 Mini",
        "size": "~2.8 GB",
        "params": "3.8B",
    },
}

SUMMARY_PROMPT = """You are a meeting assistant. Summarize the following transcript concisely. Include:

1. **Summary** — 2-3 sentence overview of what was discussed.
2. **Key Points** — bullet list of the main topics and decisions.
3. **Action Items** — bullet list of tasks or follow-ups mentioned (with who, if known).

If the transcript is a voice memo rather than a meeting, just provide a concise summary and key points.

Transcript:
"""


def load(model_key="qwen2.5-3b", on_progress=None):
    """Load or switch the summarization model."""
    global _model, _tokenizer, _current_model_id

    model_info = SUMMARY_MODELS.get(model_key)
    if not model_info:
        raise ValueError(f"Unknown summary model: {model_key}")

    if _model and _current_model_id == model_info["id"]:
        return

    device = detect_device()

    if on_progress:
        on_progress(f"Loading {model_info['label']} ({model_info['size']})...")

    model_id = model_info["id"]
    _tokenizer = AutoTokenizer.from_pretrained(model_id)

    load_kwargs = {
        "torch_dtype": torch.float16 if device == "cuda" else torch.float32,
    }
    if device == "cuda":
        load_kwargs["device_map"] = "auto"

    _model = AutoModelForCausalLM.from_pretrained(model_id, **load_kwargs)

    if device != "cuda":
        _model = _model.to(device)

    _current_model_id = model_id

    if on_progress:
        on_progress(f"{model_info['label']} ready on {device.upper()}")


def summarize(text, on_progress=None):
    """Summarize a transcript. Returns dict with 'summary' key."""
    if _model is None:
        raise RuntimeError("Summary model not loaded")

    if on_progress:
        on_progress("Summarizing...")

    # Chunk long transcripts (roughly 2000 words per chunk)
    words = text.split()
    if len(words) > 2000:
        chunks = []
        for i in range(0, len(words), 1500):
            chunks.append(" ".join(words[i:i + 1500]))

        # Summarize each chunk, then summarize the summaries
        partial_summaries = []
        for i, chunk in enumerate(chunks):
            if on_progress:
                on_progress(f"Summarizing part {i + 1}/{len(chunks)}...")
            result = _generate(SUMMARY_PROMPT + chunk)
            partial_summaries.append(result)

        combined = "\n\n".join(partial_summaries)
        if on_progress:
            on_progress("Combining summaries...")
        summary = _generate(
            "Combine these partial summaries into one cohesive summary with "
            "**Summary**, **Key Points**, and **Action Items** sections:\n\n"
            + combined
        )
    else:
        summary = _generate(SUMMARY_PROMPT + text)

    return {"summary": summary}


def _generate(prompt):
    """Run text generation on the loaded model."""
    messages = [{"role": "user", "content": prompt}]
    text = _tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

    inputs = _tokenizer(text, return_tensors="pt").to(_model.device)

    with torch.no_grad():
        outputs = _model.generate(
            **inputs,
            max_new_tokens=600,
            temperature=0.3,
            do_sample=True,
            top_p=0.9,
            repetition_penalty=1.1,
        )

    # Decode only the generated part (skip input tokens)
    generated = outputs[0][inputs["input_ids"].shape[1]:]
    return _tokenizer.decode(generated, skip_special_tokens=True).strip()


def get_models():
    """Return available summary models for the frontend."""
    return SUMMARY_MODELS


def unload():
    """Free the model from memory."""
    global _model, _tokenizer, _current_model_id
    if _model:
        del _model
        _model = None
    _tokenizer = None
    _current_model_id = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
