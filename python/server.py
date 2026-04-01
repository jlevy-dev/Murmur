"""Murmur ML backend — WebSocket server for transcription, diarization, summarization."""
import asyncio
import json
import sys
import traceback

import websockets
import numpy as np

import audio_utils
import transcribe
import diarize
import summarize
from gpu import gpu_info

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

        elif msg_type == "gpu-info":
            await send_result(gpu_info())

        elif msg_type == "get-summary-models":
            await send_result(summarize.get_models())

        elif msg_type == "load-model":
            task = msg.get("task")
            if task == "transcription":
                model_size = msg.get("modelSize", "base")
                await loop.run_in_executor(
                    None, transcribe.load, model_size, sync_progress
                )
            elif task == "summarization":
                model_key = msg.get("modelKey", "qwen2.5-3b")
                await loop.run_in_executor(
                    None, summarize.load, model_key, sync_progress
                )
            await send_result({"ok": True})

        elif msg_type == "transcribe":
            model_size = msg.get("modelSize", "base")
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

        elif msg_type == "transcribe-call":
            model_size = msg.get("modelSize", "base")
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

        elif msg_type == "summarize":
            text = msg.get("text", "")
            model_key = msg.get("modelKey", "qwen2.5-3b")

            await loop.run_in_executor(
                None, summarize.load, model_key, sync_progress
            )

            result = await loop.run_in_executor(
                None, summarize.summarize, text, sync_progress
            )
            await send_result(result)

        elif msg_type == "transcribe-stream":
            # Lightweight streaming transcription for live preview
            model_size = msg.get("modelSize", "base")
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

        elif msg_type == "preload-models":
            model_size = msg.get("modelSize", "base")
            model_key = msg.get("summaryModelKey", "qwen2.5-3b")

            # Load transcription model
            await loop.run_in_executor(
                None, transcribe.load, model_size, sync_progress
            )

            # Load summarization model
            await loop.run_in_executor(
                None, summarize.load, model_key, sync_progress
            )

            await send_result({"ok": True})

        elif msg_type == "unload":
            task = msg.get("task")
            if task == "transcription":
                transcribe.unload()
            elif task == "summarization":
                summarize.unload()
            elif task == "diarization":
                diarize.unload()
            await send_result({"ok": True})

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
