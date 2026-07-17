from ytshorts import cuts


def w(start, end, word="あ"):
    return {"start": start, "end": end, "word": word}


class TestMergeIntervals:
    def test_merges_overlapping(self):
        assert cuts.merge_intervals([(0, 2), (1, 3)]) == [(0, 3)]

    def test_keeps_separate(self):
        assert cuts.merge_intervals([(0, 1), (2, 3)]) == [(0, 1), (2, 3)]

    def test_drops_empty_and_sorts(self):
        assert cuts.merge_intervals([(5, 6), (2, 2), (0, 1)]) == [(0, 1), (5, 6)]


class TestBuildKeepIntervals:
    def test_cuts_long_pause(self):
        # 2秒の沈黙（max_pause=0.5超）はカットされ、2つの区間になる
        words = [w(1.0, 1.5), w(1.6, 2.0), w(4.0, 4.5)]
        keep = cuts.build_keep_intervals(words, 0.0, 10.0, max_pause=0.5, pad=0.1)
        assert len(keep) == 2
        assert keep[0] == (0.9, 2.1)
        assert keep[1] == (3.9, 4.6)

    def test_keeps_short_pause(self):
        words = [w(1.0, 1.5), w(1.8, 2.2)]
        keep = cuts.build_keep_intervals(words, 0.0, 10.0, max_pause=0.5, pad=0.1)
        assert len(keep) == 1

    def test_trims_leading_and_trailing_silence(self):
        words = [w(5.0, 6.0)]
        keep = cuts.build_keep_intervals(words, 0.0, 30.0, pad=0.2)
        assert keep == [(4.8, 6.2)]

    def test_no_words_keeps_whole_clip(self):
        assert cuts.build_keep_intervals([], 2.0, 8.0) == [(2.0, 8.0)]

    def test_drops_isolated_blip(self):
        # 0.1秒の孤立音（min_run=0.25未満）は捨てられる
        words = [w(1.0, 1.1), w(5.0, 6.0)]
        keep = cuts.build_keep_intervals(words, 0.0, 10.0, pad=0.1, min_run=0.25)
        assert keep == [(4.9, 6.1)]

    def test_ignores_words_outside_clip(self):
        words = [w(1.0, 2.0), w(10.0, 11.0)]
        keep = cuts.build_keep_intervals(words, 5.0, 12.0, pad=0.1)
        assert keep == [(9.9, 11.1)]

    def test_pad_clamped_to_clip(self):
        words = [w(5.0, 6.0)]
        keep = cuts.build_keep_intervals(words, 4.95, 6.05, pad=0.2)
        assert keep == [(4.95, 6.05)]


class TestSubtractIntervals:
    def test_cut_in_middle_splits(self):
        keep = cuts.subtract_intervals([(0, 10)], [(4, 6)])
        assert keep == [(0, 4), (6, 10)]

    def test_cut_covering_removes(self):
        assert cuts.subtract_intervals([(2, 4)], [(0, 5)]) == []

    def test_cut_outside_no_change(self):
        assert cuts.subtract_intervals([(0, 3)], [(5, 6)]) == [(0, 3)]

    def test_cut_at_edges(self):
        keep = cuts.subtract_intervals([(0, 10)], [(0, 2), (8, 10)])
        assert keep == [(2, 8)]


class TestMapTime:
    keep = [(2.0, 5.0), (8.0, 10.0)]

    def test_inside_first_interval(self):
        assert cuts.map_time(3.0, self.keep) == 1.0

    def test_inside_second_interval(self):
        # 最初の区間は3秒。8.0-10.0 の 9.0 は 3.0 + 1.0
        assert cuts.map_time(9.0, self.keep) == 4.0

    def test_before_everything(self):
        assert cuts.map_time(0.0, self.keep) == 0.0

    def test_in_cut_gap_snaps_forward(self):
        assert cuts.map_time(6.5, self.keep) == 3.0

    def test_after_everything(self):
        assert cuts.map_time(99.0, self.keep) == 5.0

    def test_total_kept(self):
        assert cuts.total_kept(self.keep) == 5.0


class TestMapSpan:
    def test_span_fully_kept(self):
        assert cuts.map_span(2.0, 4.0, [(2.0, 5.0)]) == (0.0, 2.0)

    def test_span_collapsed_returns_none(self):
        # 発話ごとカットされた字幕は None
        assert cuts.map_span(6.0, 7.0, [(2.0, 5.0), (8.0, 10.0)], min_len=0.15) is None
