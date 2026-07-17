from pathlib import Path

from ytshorts.config import load_config


class TestLoadConfig:
    def test_defaults_when_no_file(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        cfg = load_config()
        assert cfg.quality_threshold == 70
        assert cfg.width == 1080 and cfg.height == 1920

    def test_yaml_overrides(self, tmp_path):
        p = tmp_path / "config.yaml"
        p.write_text("quality_threshold: 85\nworkspace: /data/ws\nmax_pause: 0.8\n", encoding="utf-8")
        cfg = load_config(p)
        assert cfg.quality_threshold == 85
        assert cfg.workspace == Path("/data/ws")
        assert cfg.max_pause == 0.8

    def test_unknown_keys_ignored(self, tmp_path):
        p = tmp_path / "config.yaml"
        p.write_text("nonexistent_key: 1\n", encoding="utf-8")
        cfg = load_config(p)
        assert not hasattr(cfg, "nonexistent_key")

    def test_env_token(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("GAS_ADMIN_TOKEN", "tok123")
        cfg = load_config()
        assert cfg.gas_admin_token == "tok123"

    def test_paths(self):
        cfg = load_config("/nonexistent/config.yaml")
        assert cfg.inbox == cfg.workspace / "inbox"
        assert cfg.shorts_dir == cfg.workspace / "shorts"
