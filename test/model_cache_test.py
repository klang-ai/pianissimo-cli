import sys
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
from model_cache import resolve_checkpoint


class LocalEntryNotFoundError(Exception):
    pass


class ModelCacheTests(unittest.TestCase):
    def resolve_with(self, download, report):
        hub = ModuleType("huggingface_hub")
        hub.hf_hub_download = download
        errors = ModuleType("huggingface_hub.errors")
        errors.LocalEntryNotFoundError = LocalEntryNotFoundError
        with patch.dict(sys.modules, {"huggingface_hub": hub, "huggingface_hub.errors": errors}):
            return resolve_checkpoint("KlangAI/pianissimo-sv", "a" * 40, "/cache", report)

    def test_repeated_cache_hits_are_local_only_and_never_report_a_download(self):
        download, report = Mock(return_value="/cache/pianissimo.nemo"), Mock()
        for _ in range(2):
            self.assertEqual(self.resolve_with(download, report), ("/cache/pianissimo.nemo", True))
        self.assertEqual(download.call_count, 2)
        for call in download.call_args_list:
            self.assertTrue(call.kwargs["local_files_only"])
            self.assertEqual(call.kwargs["revision"], "a" * 40)
        for call in report.call_args_list:
            self.assertIn("cached on disk", call.args[0])
            self.assertNotIn("Downloading", call.args[0])

    def test_only_a_cache_miss_allows_a_download(self):
        download = Mock(side_effect=[LocalEntryNotFoundError(), "/cache/pianissimo.nemo"])
        report = Mock()
        self.assertEqual(self.resolve_with(download, report), ("/cache/pianissimo.nemo", False))
        self.assertTrue(download.call_args_list[0].kwargs["local_files_only"])
        self.assertNotIn("local_files_only", download.call_args_list[1].kwargs)
        self.assertIn("Downloading", report.call_args.args[0])

    def test_disk_errors_do_not_trigger_another_download(self):
        download, report = Mock(side_effect=PermissionError("Cannot read cache")), Mock()
        with self.assertRaises(PermissionError):
            self.resolve_with(download, report)
        self.assertEqual(download.call_count, 1)
        report.assert_not_called()


if __name__ == "__main__":
    unittest.main()
