#!/usr/bin/env python3
"""One loaded Pianissimo model. JSONL protocol on stdout; library logs on stderr."""
import argparse
import json
import math
import os
import sys
import traceback
from runtime import select_device
from model_cache import resolve_checkpoint

# Redirect the underlying descriptor too: native libraries can write directly to fd 1.
protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8")
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr


def emit(payload):
    protocol.write(json.dumps(payload, ensure_ascii=False, allow_nan=False) + "\n")
    protocol.flush()


def normalize(hypothesis):
    words = []
    timestamps = getattr(hypothesis, "timestamp", None) or {}
    for word in timestamps.get("word", []):
        start, end = float(word["start"]), float(word["end"])
        text = str(word.get("word", word.get("text", ""))).strip()
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
            raise ValueError("Pianissimo returned invalid word timestamps.")
        if text:
            words.append({"start": start, "end": end, "text": text})
    text = str(hypothesis.text).strip()
    if text and not words:
        raise ValueError("Pianissimo returned text without word timestamps. Check the NeMo version.")
    return {"text": text, "words": words}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--model", default="KlangAI/pianissimo-sv")
    parser.add_argument("--revision", default="8f1f6d8f8bd7482a5ea1d2bfaf6ef5be61597138")
    parser.add_argument("--device", choices=["auto", "cpu", "cuda", "mps"], default="auto")
    parser.add_argument("--cache-dir", required=True)
    args = parser.parse_args()
    def checkpoint_from_disk_or_download():
        return resolve_checkpoint(args.model, args.revision, args.cache_dir,
                                  lambda text: emit({"type": "status", "message": text}))

    # Fetching weights does not require importing or initializing the inference stack.
    if args.download:
        checkpoint, cached = checkpoint_from_disk_or_download()
        emit({"ok": True, "checkpoint": checkpoint, "revision": args.revision, "cached": cached})
        return
    # NeMo requires CPU fallback for operators not yet implemented by Metal.
    # PyTorch reads this at import time. An explicit user override is respected.
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    import torch
    from nemo.collections.asr.models import ASRModel
    import importlib.metadata
    cuda_available = torch.cuda.is_available()
    mps_available = torch.backends.mps.is_available()
    device = select_device(args.device, cuda_available=cuda_available, mps_available=mps_available)
    if device == "mps":
        # NeMo replaces the CPU batch immediately after its non-blocking copy.
        # MPS can then read released storage, corrupting audio and sequence lengths.
        # Keep CPU tensors alive until transfer completes; CUDA keeps its fast path.
        from functools import partial
        from nemo.collections.asr.parts.mixins import transcription
        transcription.move_data_to_device = partial(transcription.move_data_to_device, non_blocking=False)
    device_name = torch.cuda.get_device_name(0) if device == "cuda" else (
        torch.backends.mps.get_name() if device == "mps" and hasattr(torch.backends.mps, "get_name") else
        "Apple GPU" if device == "mps" else "CPU"
    )
    runtime = {"device": device, "deviceName": device_name, "torch": torch.__version__,
               "nemo": importlib.metadata.version("nemo_toolkit")}
    if args.check:
        emit({"ok": True, "python": sys.version.split()[0], "torch": torch.__version__,
              "nemo": runtime["nemo"], "cuda": cuda_available, "mps": mps_available,
              "device": device, "deviceName": device_name})
        return
    checkpoint, _ = checkpoint_from_disk_or_download()
    # Leave room for download/normalization; avoid oversubscribing laptop CPUs.
    torch.set_num_threads(max(1, min(8, os.cpu_count() or 1)))
    emit({"type": "status", "message": f"Loading Pianissimo from disk onto {device} ({device_name})."})
    model = ASRModel.restore_from(restore_path=checkpoint, map_location=torch.device(device)).eval()
    actual_device = next(model.parameters()).device.type
    if actual_device != device:
        raise RuntimeError(f"The model loaded on {actual_device} instead of the requested {device} device.")
    emit({"type": "ready", **runtime, "revision": args.revision})
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            if request.get("type") == "close":
                break
            if request.get("type") != "transcribe" or not isinstance(request.get("path"), str):
                raise ValueError("Expected a transcribe request with an audio path.")
            with torch.inference_mode():
                hypotheses = model.transcribe(audio=[request["path"]], batch_size=1,
                                               return_hypotheses=True, timestamps=True,
                                               num_workers=0, verbose=False)
            emit({"type": "result", "id": request["id"], **normalize(hypotheses[0])})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            emit({"type": "error", "id": request.get("id") if request else None, "error": str(error)})
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            if device == "mps":
                torch.mps.empty_cache()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "error": str(error)})
        sys.exit(1)
