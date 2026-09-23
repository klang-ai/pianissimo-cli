import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
from runtime import select_device


class DeviceSelectionTests(unittest.TestCase):
    def test_auto_prefers_cuda_then_mps_then_cpu(self):
        for cuda, mps, expected in [(True, True, "cuda"), (True, False, "cuda"),
                                     (False, True, "mps"), (False, False, "cpu")]:
            with self.subTest(cuda=cuda, mps=mps):
                self.assertEqual(select_device("auto", cuda_available=cuda, mps_available=mps), expected)

    def test_cpu_override_wins_over_available_gpus(self):
        self.assertEqual(select_device("cpu", cuda_available=True, mps_available=True), "cpu")

    def test_explicit_mps_wins_over_cuda(self):
        self.assertEqual(select_device("mps", cuda_available=True, mps_available=True), "mps")

    def test_unavailable_explicit_gpu_never_silently_becomes_cpu(self):
        for requested, description in [("mps", "Apple GPU"), ("cuda", "CUDA")]:
            with self.subTest(requested=requested), self.assertRaisesRegex(RuntimeError, description):
                select_device(requested, cuda_available=False, mps_available=False)

    def test_unknown_devices_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unknown inference device"):
            select_device("metal", cuda_available=False, mps_available=True)


if __name__ == "__main__":
    unittest.main()
