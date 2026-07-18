import pytest

from ytshorts.compilation import (
    build_chapters,
    build_compilation_filter,
    format_chapter_time,
    select_compile_entries,
)


class TestSelectCompileEntries:
    def make(self, short_id, title, kind, score=80, video_id="v1"):
        return {"short_id": short_id, "title": title, "kind": kind,
                "score": score, "video_id": video_id, "url_private": "https://x/f"}

    def test_prefers_wide_over_short(self):
        shorts = [self.make("a", "話1", "short"), self.make("b", "話1", "wide")]
        picked = select_compile_entries(shorts, 0)
        assert [s["short_id"] for s in picked] == ["b"]

    def test_falls_back_to_short_when_no_wide(self):
        picked = select_compile_entries([self.make("a", "話1", "short")], 0)
        assert [s["short_id"] for s in picked] == ["a"]

    def test_filters_by_score_and_url(self):
        shorts = [
            self.make("a", "話1", "short", score=50),
            dict(self.make("b", "話2", "short"), url_private=""),
        ]
        assert select_compile_entries(shorts, 60) == []

    def test_different_titles_kept_separately(self):
        shorts = [self.make("a", "話1", "wide"), self.make("b", "話2", "short")]
        assert len(select_compile_entries(shorts, 0)) == 2


class TestBuildCompilationFilter:
    def test_two_shorts(self):
        fc = build_compilation_filter(2)
        assert "boxblur" in fc
        assert "[0:v]scale=-2:1080[fg0]" in fc
        assert "[bg1][fg1]overlay" in fc
        assert "concat=n=2:v=1:a=1[vout][aout]" in fc

    def test_zero_raises(self):
        with pytest.raises(ValueError):
            build_compilation_filter(0)


class TestChapters:
    def test_format_chapter_time(self):
        assert format_chapter_time(0) == "0:00"
        assert format_chapter_time(75) == "1:15"
        assert format_chapter_time(3700) == "1:01:40"

    def test_build_chapters_cumulative(self):
        entries = [{"title": "一本目"}, {"title": "二本目"}, {"title": "三本目"}]
        chapters = build_chapters(entries, [30.0, 45.5, 20.0])
        assert chapters.splitlines() == [
            "0:00 一本目",
            "0:30 二本目",
            "1:15 三本目",
        ]
