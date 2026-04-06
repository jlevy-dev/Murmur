"""Murmur ML backend — WebSocket server for transcription, diarization, summarization."""
import asyncio
import gc
import json
import sys
import traceback

import websockets
import numpy as np

import audio_utils
import transcribe
import diarize
import summarize
from gpu import gpu_info, recommend_models


def _try_free_gpu():
    """Best-effort GPU memory cleanup after an OOM or other CUDA error."""
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _format_error(e, operation):
    """Return a user-friendly error string, with special handling for CUDA OOM."""
    msg = str(e)
    if "CUDA out of memory" in msg or "OutOfMemoryError" in type(e).__name__:
        return (
            f"{operation} failed: GPU out of memory. "
            "Try a smaller model or close other GPU-intensive applications."
        )
    return f"{operation} failed: {msg}"

PORT = 9735
clients = set()


async def handle_message(ws, raw):
    """Dispatch a single message from the Electron client."""
    msg = json.loads(raw)
    msg_type = msg.get("type")
    req_id = msg.get("requestId")

    async def send_progress(status, percent=None):
        payload = {"type": "progress", "requestId": req_id, "status": status}
        if percent is not None:
            payload["percent"] = percent
        await ws.send(json.dumps(payload))

    async def send_result(data):
        await ws.send(json.dumps({"type": "result", "requestId": req_id, "data": data}))

    async def send_error(message):
        await ws.send(json.dumps({"type": "error", "requestId": req_id, "message": message}))

    def sync_progress(status):
        """Sync progress callback for use in blocking functions."""
        asyncio.run_coroutine_threadsafe(send_progress(status), loop)

    loop = asyncio.get_event_loop()

    try:
        if msg_type == "ping":
            await ws.send(json.dumps({"type": "pong"}))

        elif msg_type == "gpu-info" or msg_type == "get-gpu-info":
            info = gpu_info()
            vram = info.get("vram_free_mb", 0)
            info["recommendations"] = recommend_models(vram)
            await send_result(info)

        elif msg_type == "get-summary-models":
            await send_result(summarize.get_models())

        elif msg_type == "load-model":
            try:
                task = msg.get("task")
                if task == "transcription":
                    model_size = msg.get("modelSize", "parakeet-tdt-0.6b")
                    await loop.run_in_executor(
                        None, transcribe.load, model_size, sync_progress
                    )
                elif task == "summarization":
                    model_key = msg.get("modelKey", "qwen2.5-3b")
                    await loop.run_in_executor(
                        None, summarize.load, model_key, sync_progress
                    )
                await send_result({"ok": True})
            except Exception as e:
                traceback.print_exc()
                _try_free_gpu()
                await send_error(_format_error(e, "Model loading"))

        elif msg_type == "transcribe":
            try:
                model_size = msg.get("modelSize", "parakeet-tdt-0.6b")
                language = msg.get("language")
                sample_rate = msg.get("sampleRate", 16000)

                # Decode audio
                pcm = audio_utils.decode_base64_pcm(msg["audioBase64"])

                # Ensure model loaded
                await loop.run_in_executor(
                    None, transcribe.load, model_size, sync_progress
                )

                # Trim silence
                await send_progress("Filtering silence...")
                orig_dur = len(pcm) / sample_rate
                pcm = await loop.run_in_executor(
                    None, audio_utils.trim_silence, pcm, sample_rate
                )
                trim_dur = len(pcm) / sample_rate
                await send_progress(f"Filtered: {orig_dur:.1f}s -> {trim_dur:.1f}s")

                # Transcribe
                result = await loop.run_in_executor(
                    None, transcribe.transcribe, pcm, sample_rate, language, sync_progress
                )
                await send_result(result)
            except Exception as e:
                traceback.print_exc()
                _try_free_gpu()
                await send_error(_format_error(e, "Transcription"))

        elif msg_type == "transcribe-call":
            try:
                model_size = msg.get("modelSize", "parakeet-tdt-0.6b")
                language = msg.get("language")
                sample_rate = msg.get("sampleRate", 16000)

                mic_pcm = audio_utils.decode_base64_pcm(msg["micBase64"])
                sys_pcm = audio_utils.decode_base64_pcm(msg["sysBase64"])

                # Load transcription model
                await loop.run_in_executor(
                    None, transcribe.load, model_size, sync_progress
                )

                # Transcribe mic -> "You"
                await send_progress("Transcribing mic audio...")
                mic_trimmed = await loop.run_in_executor(
                    None, audio_utils.trim_silence, mic_pcm, sample_rate
                )
                mic_result = await loop.run_in_executor(
                    None, transcribe.transcribe, mic_trimmed, sample_rate, language, sync_progress
                )

                # Transcribe system audio
                await send_progress("Transcribing system audio...")
                sys_trimmed = await loop.run_in_executor(
                    None, audio_utils.trim_silence, sys_pcm, sample_rate
                )
                sys_result = await loop.run_in_executor(
                    None, transcribe.transcribe, sys_trimmed, sample_rate, language, sync_progress
                )

                # Diarize system audio
                await send_progress("Diarizing speakers...")
                sys_chunks = await loop.run_in_executor(
                    None, diarize.diarize, sys_pcm, sample_rate, sys_result["chunks"], sync_progress
                )

                # Tag mic chunks as "You"
                mic_chunks = [dict(c, speaker="You") for c in mic_result["chunks"]]

                # Merge and sort by timestamp
                all_chunks = mic_chunks + sys_chunks
                all_chunks.sort(key=lambda c: c.get("timestamp", [0])[0])

                full_text = " ".join(c["text"].strip() for c in all_chunks)

                await send_result({
                    "text": full_text,
                    "chunks": all_chunks,
                    "detectedLanguage": mic_result.get("detectedLanguage", "unknown"),
                })
            except Exception as e:
                traceback.print_exc()
                _try_free_gpu()
                await send_error(_format_error(e, "Call transcription"))

        elif msg_type == "summarize":
            try:
                text = msg.get("text", "")
                model_key = msg.get("modelKey", "qwen2.5-3b")

                await loop.run_in_executor(
                    None, summarize.load, model_key, sync_progress
                )

                result = await loop.run_in_executor(
                    None, summarize.summarize, text, sync_progress
                )
                await send_result(result)
            except Exception as e:
                traceback.print_exc()
                _try_free_gpu()
                await send_error(_format_error(e, "Summarization"))

        elif msg_type == "transcribe-stream":
            try:
                # Lightweight streaming transcription for live preview
                model_size = msg.get("modelSize", "parakeet-tdt-0.6b")
                sample_rate = msg.get("sampleRate", 16000)

                pcm = audio_utils.decode_base64_pcm(msg["audioBase64"])
                if len(pcm) < sample_rate * 0.5:
                    await send_result({"text": ""})
                    return

                await loop.run_in_executor(
                    None, transcribe.load, model_size, None
                )

                result = await loop.run_in_executor(
                    None, transcribe.transcribe, pcm, sample_rate, None, None
                )
                await send_result({"text": result.get("text", "")})
            except Exception as e:
                traceback.print_exc()
                _try_free_gpu()
                await send_error(_format_error(e, "Stream transcription"))

        elif msg_type == "preload-models":
            try:
                model_size = msg.get("modelSize", "parakeet-tdt-0.6b")
                model_key = msg.get("summaryModelKey", "qwen2.5-3b")

                # Check VRAM and warn if requested models may exceed capacity
                info = gpu_info()
                vram_warning = None
                if info.get("available"):
                    vram_free = info.get("vram_free_mb", 0)
                    recs = recommend_models(vram_free)
                    # Rough VRAM cost ordering for transcription models
                    transcription_rank = {"parakeet-tdt-0.6b": 0, "parakeet-tdt-1.1b": 1}
                    summary_rank = {None: 0, "qwen2.5-1.5b": 1, "qwen2.5-3b": 2}
                    req_t = transcription_rank.get(model_size, 0)
                    rec_t = transcription_rank.get(recs["transcription_model"], 0)
                    req_s = summary_rank.get(model_key, 1)
                    rec_s = summary_rank.get(recs["summary_model"], 1)
                    if req_t > rec_t or req_s > rec_s:
                        vram_warning = (
                            f"Requested models ({model_size} + {model_key}) may exceed "
                            f"available VRAM ({vram_free} MB free). "
                            f"Recommended: {recs['transcription_model']} + {recs['summary_model'] or 'none'}."
                        )
                        await send_progress(f"Warning: {vram_warning}")

                # Load transcription model
                await loop.run_in_executor(
                    None, transcribe.load, model_size, sync_progress
                )

                # Load summarization model
                await loop.run_in_executor(
                    None, summarize.load, model_key, sync_progress
                )

                result = {"ok": True}
                if vram_warning:
                    result["vram_warning"] = vram_warning
                await send_result(result)
            except Exception as e:
                traceback.print_exc()
                _try_free_gpu()
                await send_error(_format_error(e, "Model preloading"))

        elif msg_type == "unload":
            try:
                task = msg.get("task")
                if task == "transcription":
                    transcribe.unload()
                elif task == "summarization":
                    summarize.unload()
                elif task == "diarization":
                    diarize.unload()
                _try_free_gpu()
                await send_result({"ok": True})
            except Exception as e:
                traceback.print_exc()
                await send_error(_format_error(e, "Unload"))

        else:
            await send_error(f"Unknown message type: {msg_type}")

    except Exception as e:
        traceback.print_exc()
        await send_error(str(e))


async def handler(ws):
    """Handle a WebSocket connection."""
    clients.add(ws)
    print(f"[Murmur] Client connected ({len(clients)} total)")
    try:
        async for message in ws:
            await handle_message(ws, message)
    except websockets.ConnectionClosed:
        pass
    finally:
        clients.discard(ws)
        print(f"[Murmur] Client disconnected ({len(clients)} total)")


async def main():
    info = gpu_info()
    if info["available"]:
        print(f"[Murmur] GPU: {info['name']} ({info['vram_free_mb']}MB free)")
    else:
        print("[Murmur] No GPU detected — running on CPU")

    print(f"[Murmur] WebSocket server starting on ws://localhost:{PORT}")
    try:
        async with websockets.serve(handler, "localhost", PORT, max_size=500 * 1024 * 1024, ping_timeout=None, ping_interval=None):
            print(f"[Murmur] Ready")
            await asyncio.Future()  # run forever
    except OSError as e:
        if e.errno == 10048 or "address already in use" in str(e).lower():
            # Kill whatever is using the port and retry
            print(f"[Murmur] Port {PORT} in use, killing existing process...")
            import subprocess
            subprocess.run(
                ["powershell", "-Command",
                 f"Get-NetTCPConnection -LocalPort {PORT} -ErrorAction SilentlyContinue | "
                 f"ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force }}"],
                capture_output=True
            )
            await asyncio.sleep(1)
            async with websockets.serve(handler, "localhost", PORT, max_size=500 * 1024 * 1024, ping_timeout=None, ping_interval=None):
                print(f"[Murmur] Ready (after port recovery)")
                await asyncio.Future()
        else:
            raise


if __name__ == "__main__":
    asyncio.run(main())
