"""Temporary CI probe: compare CPU and MPS stages on identical speech."""
import argparse
import json
import os
from pathlib import Path

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
import torch
from nemo.collections.asr.models import ASRModel

parser = argparse.ArgumentParser()
parser.add_argument("--load-on", choices=["cpu", "mps"], required=True)
args = parser.parse_args()
checkpoint = next(Path(os.environ["PIANISSIMO_HOME"]).rglob("*.nemo"))
torch.set_num_threads(4)
model = ASRModel.restore_from(str(checkpoint), map_location=torch.device(args.load_on)).eval()
stages = {}
def capture(name):
    def hook(module, inputs, output):
        stages[name] = output[0].detach().cpu().clone()
    return hook
model.preprocessor.register_forward_hook(capture("features"))
model.encoder.register_forward_hook(capture("encoded"))
reference = None
for device in ["mps", "cpu", "mps", "mps"]:
    model.to(device)
    with torch.inference_mode():
        result = model.transcribe(audio=["test/fixtures/swedish.wav"], batch_size=1,
                                  return_hypotheses=True, timestamps=True, num_workers=0, verbose=False)[0]
    report = {"torch": torch.__version__, "load_on": args.load_on, "device": device,
              "text": result.text, "stages": {}}
    for name, value in stages.items():
        stats = {"finite": bool(value.isfinite().all()), "min": float(value.min()), "max": float(value.max())}
        if reference:
            stats["cpu_max_error"] = float((value - reference[name]).abs().max())
            stats["cpu_mean_error"] = float((value - reference[name]).abs().mean())
        report["stages"][name] = stats
    print("MPS_PROBE " + json.dumps(report), flush=True)
    if device == "cpu":
        reference = dict(stages)
