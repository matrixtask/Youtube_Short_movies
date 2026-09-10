import importlib.util
import io
import json
from pathlib import Path
from unittest.mock import Mock


spec = importlib.util.spec_from_file_location("pull_env", Path(__file__).resolve().parents[2] / "setup/pull-env.py")
pull_env = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pull_env)


def test_openai_only_environment_is_valid(monkeypatch):
    transport = Mock(return_value=io.BytesIO(b'{"ok":true}'))
    monkeypatch.setattr(pull_env.urllib.request, "urlopen", transport)
    env = {"OPENAI_API_KEY": "test-key", "SLACK_BOT_TOKEN": "test-slack", "GAS_ADMIN_TOKEN": "test-admin",
           "YTSHORTS_GAS_WEBAPP_URL": "https://script.google.com/macros/s/" + "x" * 70 + "/exec"}
    assert pull_env.validate(env) == []
    assert transport.call_count == 1
    env["YTSHORTS_LLM_PROVIDER"] = "anthropic"
    assert "ANTHROPIC_API_KEY が空です" in pull_env.validate(env)
    assert transport.call_count == 1


def test_explicit_openai_cannot_pass_using_anthropic_key(monkeypatch):
    transport = Mock(side_effect=AssertionError("unexpected network"))
    monkeypatch.setattr(pull_env.urllib.request, "urlopen", transport)
    problems = pull_env.validate({"YTSHORTS_LLM_PROVIDER": "openai", "ANTHROPIC_API_KEY": "legacy"})
    assert "OPENAI_API_KEY が空です" in problems
    transport.assert_not_called()


def test_gas_settings_are_mapped_and_survive_env_rebuild(monkeypatch, tmp_path):
    response = {"ok": True, "env": {"OPENAI_API_KEY": "test-key", "LLM_PROVIDER": "openai",
                                    "OPENAI_MODEL": "gpt-6-astra", "OPENAI_REASONING_EFFORT": "high"}}
    monkeypatch.setattr(pull_env.urllib.request, "urlopen", Mock(return_value=io.BytesIO(json.dumps(response).encode())))
    env = pull_env.fetch_from_gas("https://example.invalid", "test-admin")
    assert env["YTSHORTS_LLM_PROVIDER"] == "openai"
    assert env["YTSHORTS_OPENAI_MODEL"] == "gpt-6-astra"
    assert env["YTSHORTS_OPENAI_REASONING_EFFORT"] == "high"
    monkeypatch.setattr(pull_env, "ENV_PATH", tmp_path / ".env")
    pull_env.write_env(env)
    assert all(pull_env.parse_env_file(tmp_path / ".env")[key] == value for key, value in env.items())
