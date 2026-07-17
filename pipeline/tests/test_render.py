from pathlib import Path

import pytest

from ytshorts.config import Config
from ytshorts.render import build_filter_complex, build_short_command, escape_filter_path


class TestEscapeFilterPath:
    def test_colon_escaped(self):
        assert escape_filter_path("C:/subs.ass") == "C\\:/subs.ass"

    def test_plain_path_unchanged(self):
        assert escape_filter_path("/tmp/subs.ass") == "/tmp/subs.ass"


class TestBuildFilterComplex:
    def test_single_interval_no_extras(self):
        fc = build_filter_complex([(2.0, 5.0)], None, [])
        assert "[0:v]trim=start=2.000:end=5.000,setpts=PTS-STARTPTS[v0]" in fc
        assert "[0:a]atrim=start=2.000:end=5.000,asetpts=PTS-STARTPTS[a0]" in fc
        assert "concat=n=1:v=1:a=1[vcut][acut]" in fc
        assert "scale=1080:1920:force_original_aspect_ratio=increase" in fc
        assert "crop=1080:1920" in fc
        assert fc.endswith("[vout]")
        assert "ass=" not in fc

    def test_multiple_intervals_concat(self):
        fc = build_filter_complex([(0.0, 1.0), (2.0, 3.0), (4.0, 5.0)], None, [])
        assert "concat=n=3:v=1:a=1" in fc
        assert "[v0][a0][v1][a1][v2][a2]concat" in fc

    def test_subtitles_included(self):
        fc = build_filter_complex([(0.0, 1.0)], "/tmp/s1.ass", [])
        assert "ass='/tmp/s1.ass'[vsub]" in fc

    def test_illustration_overlay_with_enable_window(self):
        fc = build_filter_complex([(0.0, 10.0)], None, [(1, 3.0, 6.0)])
        assert "[1:v]scale=864:-1[ill0]" in fc
        assert "enable='between(t,3.000,6.000)'" in fc

    def test_empty_keep_raises(self):
        with pytest.raises(ValueError):
            build_filter_complex([], None, [])


class TestBuildShortCommand:
    def test_inputs_and_maps(self):
        cfg = Config()
        cmd = build_short_command(
            Path("in.mp4"),
            [(0.0, 5.0)],
            Path("subs.ass"),
            [(Path("ill.png"), 1.0, 3.0)],
            Path("out.mp4"),
            cfg,
        )
        assert cmd[:4] == ["ffmpeg", "-y", "-i", "in.mp4"]
        assert "ill.png" in cmd
        assert "[vout]" in cmd and "[acut]" in cmd
        assert cmd[-1] == "out.mp4"
        # 挿絵は入力インデックス1として参照される
        fc = cmd[cmd.index("-filter_complex") + 1]
        assert "[1:v]" in fc
