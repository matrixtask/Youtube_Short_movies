from ytshorts.subtitles import (
    HOOK_DURATION,
    ass_color,
    ass_escape,
    build_ass,
    build_ass_header,
    build_events,
    format_ass_time,
)


class TestAssColor:
    def test_white(self):
        assert ass_color("#FFFFFF") == "&H00FFFFFF"

    def test_rgb_to_bgr(self):
        # ASSは &H00BBGGRR 形式
        assert ass_color("#FFE600") == "&H0000E6FF"

    def test_invalid_falls_back_to_white(self):
        assert ass_color("red") == "&H00FFFFFF"


class TestBuildAssHeader:
    def test_landscape_scales_margins(self):
        header = build_ass_header(1920, 1080)
        assert "PlayResX: 1920" in header
        assert "PlayResY: 1080" in header
        assert f",{round(1080 * 0.177)},1" in header  # Captionの下余白が高さに追従

    def test_custom_style(self):
        header = build_ass_header(1080, 1920, font="Rounded Mplus", caption_color="#00FF00")
        assert "Rounded Mplus" in header
        assert "&H0000FF00" in header

    def test_custom_positions_and_size(self):
        header = build_ass_header(1080, 1920, caption_margin=0.25,
                                  tsukkomi_margin=0.5, caption_fontsize=90)
        assert f",{round(1920 * 0.25)},1" in header   # 字幕位置
        assert f",{round(1920 * 0.5)},1" in header    # ツッコミ位置
        assert ",90," in header                        # フォントサイズ


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


class TestFitLayoutTitle:
    def test_title_shown_for_whole_short(self):
        short = {"title": "渋滞の話", "hook": "", "captions": [], "overlays": []}
        events = build_events(short, [(10.0, 25.0)], layout="fit")
        assert len(events) == 1
        assert "Title" in events[0]
        assert "0:00:15.00" in events[0]  # カット後の長さ = 15秒ぶん表示

    def test_no_title_event_in_crop_layout(self):
        short = {"title": "渋滞の話", "hook": "", "captions": [], "overlays": []}
        assert build_events(short, [(10.0, 25.0)], layout="crop") == []

    def test_header_has_title_style(self):
        assert "Style: Title," in build_ass_header()


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
