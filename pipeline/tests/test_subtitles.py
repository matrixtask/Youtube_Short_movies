from ytshorts.subtitles import HOOK_DURATION, ass_escape, build_ass, build_events, format_ass_time


class TestFormatAssTime:
    def test_zero(self):
        assert format_ass_time(0) == "0:00:00.00"

    def test_minutes_seconds(self):
        assert format_ass_time(75.5) == "0:01:15.50"

    def test_hours(self):
        assert format_ass_time(3661.0) == "1:01:01.00"

    def test_negative_clamped(self):
        assert format_ass_time(-3) == "0:00:00.00"


class TestAssEscape:
    def test_braces_replaced(self):
        # {} はASSのオーバーライドタグになるので無害化する
        assert ass_escape("a{b}c") == "a(b)c"

    def test_newline(self):
        assert ass_escape("a\nb") == "a\\Nb"


class TestBuildEvents:
    keep = [(10.0, 20.0)]

    def test_hook_event_at_start(self):
        short = {"hook": "衝撃の事実", "captions": [], "overlays": []}
        events = build_events(short, self.keep)
        assert len(events) == 1
        assert "Hook" in events[0]
        assert events[0].startswith("Dialogue: 0,0:00:00.00,")
        assert format_ass_time(HOOK_DURATION) in events[0]

    def test_caption_mapped_to_output_timeline(self):
        short = {"hook": "", "captions": [{"start": 12.0, "end": 14.0, "text": "こんにちは"}], "overlays": []}
        events = build_events(short, self.keep)
        # 元動画の12-14秒 → 出力の2-4秒
        assert events == [
            "Dialogue: 0,0:00:02.00,0:00:04.00,Caption,,0,0,0,,こんにちは"
        ]

    def test_caption_in_cut_region_dropped(self):
        keep = [(0.0, 5.0), (10.0, 15.0)]
        short = {"hook": "", "captions": [{"start": 6.0, "end": 8.0, "text": "消える"}], "overlays": []}
        assert build_events(short, keep) == []

    def test_overlay_uses_tsukkomi_style(self):
        short = {"hook": "", "captions": [], "overlays": [{"time": 15.0, "duration": 2.0, "text": "なんでやねん"}]}
        events = build_events(short, self.keep)
        assert "Tsukkomi" in events[0]
        assert "0:00:05.00,0:00:07.00" in events[0]


class TestBuildAss:
    def test_full_document(self):
        short = {
            "hook": "フック",
            "captions": [{"start": 11.0, "end": 12.0, "text": "字幕"}],
            "overlays": [],
        }
        doc = build_ass(short, [(10.0, 20.0)], 1080, 1920)
        assert "PlayResX: 1080" in doc
        assert "PlayResY: 1920" in doc
        assert doc.count("Dialogue:") == 2
        assert doc.endswith("\n")
