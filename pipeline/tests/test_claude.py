import pytest

from ytshorts.claude import parse_json_loose


class TestParseJsonLoose:
    def test_plain_json(self):
        assert parse_json_loose('{"a": 1}') == {"a": 1}

    def test_fenced_json(self):
        assert parse_json_loose('```json\n{"a": 1}\n```') == {"a": 1}

    def test_json_with_preamble(self):
        assert parse_json_loose('プランはこちら:\n[{"id": "s1"}]\nどうぞ') == [{"id": "s1"}]

    def test_no_json_raises(self):
        with pytest.raises(ValueError):
            parse_json_loose("JSONはありません")

    def test_empty_raises(self):
        with pytest.raises(ValueError):
            parse_json_loose(None)
