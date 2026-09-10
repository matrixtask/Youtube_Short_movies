import io
import json
import urllib.error
from unittest.mock import Mock

import pytest

from ytshorts import cli, llm, planner, illustrations
from ytshorts.config import Config, load_config


def completed(text):
    return {"status": "completed", "output": [
        {"type": "reasoning", "summary": []},
        {"type": "message", "content": [{"type": "output_text", "text": text}]},
    ]}


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(llm.urllib.request, "urlopen", Mock(side_effect=AssertionError("unexpected network")))


def test_auto_selects_astra_but_explicit_legacy_wins(monkeypatch):
    assert llm.provider(Config()) == "anthropic"
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    assert llm.identity(Config())["model"] == "gpt-6-astra"
    assert llm.provider(Config(llm_provider="anthropic")) == "anthropic"


def test_config_env_overrides_yaml(tmp_path, monkeypatch):
    path = tmp_path / "config.yaml"
    path.write_text("llm_provider: anthropic\nopenai_reasoning_effort: low\n")
    monkeypatch.setenv("YTSHORTS_LLM_PROVIDER", "openai")
    monkeypatch.setenv("YTSHORTS_OPENAI_MODEL", "gpt-6-astra")
    monkeypatch.setenv("YTSHORTS_OPENAI_REASONING_EFFORT", "high")
    assert llm.identity(load_config(path)) == {
        "provider": "openai", "model": "gpt-6-astra", "reasoning": "high"}


def test_text_and_vision_use_responses_contract(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    image = tmp_path / "frame.jpg"
    image.write_bytes(b"sample")
    transport = Mock(side_effect=lambda *a, **k: io.BytesIO(json.dumps(completed('{"score":85}')).encode()))
    monkeypatch.setattr(llm.urllib.request, "urlopen", transport)
    assert llm.ask_json("system", "user", Config(), images=[image]) == {"score": 85}
    request = transport.call_args.args[0]
    payload = json.loads(request.data)
    assert request.full_url == "https://api.openai.com/v1/responses"
    assert request.get_header("Authorization") == "Bearer test-key"
    assert payload["model"] == "gpt-6-astra"
    assert payload["instructions"] == "system"
    assert payload["store"] is False
    assert payload["reasoning"] == {"effort": "medium"}
    assert payload["max_output_tokens"] == 12000
    content = payload["input"][0]["content"]
    assert content[0]["type"] == "input_text"
    assert content[1] == {"type": "input_image", "image_url": "data:image/jpeg;base64,c2FtcGxl", "detail": "auto"}
    assert not {"temperature", "top_p", "max_tokens", "messages"}.intersection(payload)


@pytest.mark.parametrize("body", [
    {"status": "incomplete", "output": [{"type": "message", "content": [{"type": "output_text", "text": "{}"}]}]},
    {"status": "failed", "output": []},
    {"status": "completed", "output": []},
    {"status": "completed", "output": [{"type": "message", "content": [{"type": "refusal", "refusal": "no"}]}]},
])
def test_unusable_responses_fail_closed(body):
    with pytest.raises(RuntimeError):
        llm.response_text(body)


def test_explicit_openai_requires_key_without_fallback(monkeypatch):
    legacy = Mock(side_effect=AssertionError("must not fall back"))
    monkeypatch.setattr(llm.claude, "ask_claude", legacy)
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        llm.ask_text("s", "u", Config(llm_provider="openai"))
    legacy.assert_not_called()


def test_auth_errors_are_not_retried_or_echoed(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    transport = Mock(side_effect=urllib.error.HTTPError(llm.OPENAI_URL, 401, "bad", {}, io.BytesIO(b"test-key")))
    monkeypatch.setattr(llm.urllib.request, "urlopen", transport)
    with pytest.raises(RuntimeError, match="HTTP 401") as error:
        llm.ask_text("s", "u", Config())
    assert "test-key" not in str(error.value)
    assert transport.call_count == 1


def test_transient_error_retries_same_provider(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    transport = Mock(side_effect=[
        urllib.error.HTTPError(llm.OPENAI_URL, 429, "busy", {}, io.BytesIO(b"")),
        io.BytesIO(json.dumps(completed("ok")).encode()),
    ])
    monkeypatch.setattr(llm.urllib.request, "urlopen", transport)
    monkeypatch.setattr(llm.time, "sleep", Mock())
    assert llm.ask_text("s", "u", Config()) == "ok"
    assert transport.call_count == 2


def test_json_retry_is_bounded_and_legacy_still_works(monkeypatch):
    legacy = Mock(side_effect=["invalid", '{"ok":true}'])
    monkeypatch.setattr(llm.claude, "ask_claude", legacy)
    assert llm.ask_json("s", "u", Config()) == {"ok": True}
    assert legacy.call_args.args[3] == "claude-sonnet-5"
    legacy.side_effect = ["invalid", "invalid", "must not reach"]
    with pytest.raises(RuntimeError, match="JSON"):
        llm.ask_json("s", "u", Config())
    assert legacy.call_count == 4


def test_unknown_provider_and_effort_rejected(monkeypatch):
    with pytest.raises(RuntimeError, match="llm_provider"):
        llm.ask_text("s", "u", Config(llm_provider="typo"))
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    with pytest.raises(RuntimeError, match="openai_reasoning_effort"):
        llm.ask_text("s", "u", Config(openai_reasoning_effort="none"))


def test_astra_replans_legacy_cache_and_uses_source_frames(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    cache = tmp_path / "plan.json"
    cache.write_text('{"shorts":[]}')
    raw = {"shorts": [{"clip": {"start": 0, "end": 20}, "theme": "通勤時間",
                       "target_viewer": "毎日通勤する人", "viewer_promise": "実体験の時短方法", "score": 85}]}
    ai = Mock(return_value=raw)
    monkeypatch.setattr(llm, "ask_json", ai)
    extraction = Mock(return_value=True)
    monkeypatch.setattr(planner.review, "extract_frame", extraction)
    plan = planner.load_or_generate_plan({"duration": 30, "segments": []}, tmp_path, Config(), source_video="in.mp4")
    assert plan["shorts"][0]["theme"] == "通勤時間"
    assert plan["shorts"][0]["viewer_promise"] == "実体験の時短方法"
    assert plan["_ai"]["provider"] == "openai"
    assert [call.args[1] for call in extraction.call_args_list] == [3, 15, 27]
    assert len(ai.call_args.kwargs["images"]) == 3
    assert "素材にない体験" in ai.call_args.args[0]
    # Identical provider/model/effort reuses the cache, with no extra API/extraction.
    assert planner.load_or_generate_plan({"duration": 30}, tmp_path, Config()) == plan
    assert ai.call_count == 1
    assert extraction.call_count == 3


def test_wrong_plan_shape_is_rejected():
    for plan in ([], {"shorts": "bad"}):
        with pytest.raises(RuntimeError, match="shorts"):
            planner.normalize_plan(plan, 60)


def test_illustration_cache_changes_with_prompt_and_model(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    ai = Mock(return_value='<svg viewBox="0 0 900 900"></svg>')
    monkeypatch.setattr(illustrations, "ask_text", ai)
    def convert(svg, png):
        png.write_bytes(b"image")
        return True
    monkeypatch.setattr(illustrations, "svg_to_png", convert)
    short = {"id": "s1", "illustrations": [{"prompt": "train"}]}
    cfg = Config()
    first = illustrations.generate_illustrations(short, tmp_path, cfg)
    assert illustrations.generate_illustrations(short, tmp_path, cfg) == first
    assert ai.call_count == 1
    short["illustrations"][0]["prompt"] = "plane"
    illustrations.generate_illustrations(short, tmp_path, cfg)
    assert ai.call_count == 2
    cfg.openai_reasoning_effort = "high"
    illustrations.generate_illustrations(short, tmp_path, cfg)
    assert ai.call_count == 3


def test_ai_check_routes_astra_without_video_processing(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.chdir(tmp_path)
    ai = Mock(return_value={"ok": True})
    monkeypatch.setattr(llm, "ask_json", ai)
    assert cli.main(["ai-check"]) == 0
    assert "gpt-6-astra" in capsys.readouterr().out
    assert not (tmp_path / "workspace").exists()
    ai.return_value = {"ok": False}
    assert cli.main(["ai-check"]) == 1


def test_model_switch_replaces_untracked_legacy_illustration(tmp_path, monkeypatch):
    png = tmp_path / "s1_ill0.png"
    png.write_bytes(b"old")
    short = {"id": "s1", "illustrations": [{"prompt": "train"}]}
    ai = Mock(return_value='<svg></svg>')
    monkeypatch.setattr(illustrations, "ask_text", ai)
    # No new key: keep the existing legacy asset.
    assert illustrations.generate_illustrations(short, tmp_path, Config()) == [png]
    ai.assert_not_called()
    # Registering the key must not reuse a previous model's asset.
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(illustrations, "svg_to_png", Mock(return_value=True))
    illustrations.generate_illustrations(short, tmp_path, Config())
    assert ai.call_count == 1
