import sys
import types

from ytshorts.transcribe import resolve_device


def fake_ctranslate2(monkeypatch, cuda_count):
    """ctranslate2 をスタブ化する（実物はテスト環境に無い/GPUも無い）。"""
    mod = types.SimpleNamespace(get_cuda_device_count=lambda: cuda_count)
    monkeypatch.setitem(sys.modules, "ctranslate2", mod)


class TestResolveDevice:
    def test_explicit_cpu(self):
        assert resolve_device("cpu") == ("cpu", "int8")

    def test_explicit_cuda(self):
        assert resolve_device("cuda") == ("cuda", "float16")

    def test_auto_picks_gpu_when_available(self, monkeypatch):
        fake_ctranslate2(monkeypatch, 1)
        assert resolve_device("auto") == ("cuda", "float16")

    def test_auto_falls_back_to_cpu_without_gpu(self, monkeypatch):
        fake_ctranslate2(monkeypatch, 0)
        assert resolve_device("auto") == ("cpu", "int8")

    def test_auto_survives_missing_ctranslate2(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "ctranslate2", None)
        assert resolve_device("auto") == ("cpu", "int8")
