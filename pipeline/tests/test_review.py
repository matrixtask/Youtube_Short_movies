from ytshorts.review import (
    apply_telop_action,
    normalize_review,
    pick_review_times,
    review_passed,
    thumb_candidate_times,
)


class TestPickReviewTimes:
    def test_hook_and_body_without_illustration(self):
        times = pick_review_times(40.0, [])
        assert times[0] == 0.6           # フック
        assert 40.0 * 0.55 in times      # 本編
        assert len(times) == 2

    def test_illustration_midpoint_included(self):
        times = pick_review_times(40.0, [(None, 10.0, 14.0)])
        assert 12.0 in times

    def test_short_video_clamped(self):
        for t in pick_review_times(1.0, [(None, 0.0, 5.0)]):
            assert 0.0 <= t <= 1.0


class TestThumbCandidates:
    def test_round1_and_round2_differ(self):
        assert thumb_candidate_times(30.0) != thumb_candidate_times(30.0, round2=True)

    def test_within_duration(self):
        for t in thumb_candidate_times(30.0) + thumb_candidate_times(30.0, True):
            assert 0 < t < 30.0


class TestApplyTelopAction:
    style = {"caption_fontsize": 72, "caption_margin": 0.177}

    def test_font_smaller(self):
        assert apply_telop_action(self.style, "font_smaller")["caption_fontsize"] == 61

    def test_font_floor(self):
        s = {"caption_fontsize": 42}
        assert apply_telop_action(s, "font_smaller")["caption_fontsize"] == 40

    def test_move_up(self):
        assert apply_telop_action(self.style, "move_up")["caption_margin"] == 0.227

    def test_keep_returns_copy_unchanged(self):
        out = apply_telop_action(self.style, "keep")
        assert out == self.style and out is not self.style


class TestNormalizeReview:
    def test_valid_passthrough(self):
        r = normalize_review({"telop": {"score": 85, "action": "keep"},
                              "illustration": {"score": 40, "action": "regenerate", "critique": "崩れ"}})
        assert r["telop"]["score"] == 85
        assert r["illustration"]["action"] == "regenerate"

    def test_garbage_is_safe(self):
        r = normalize_review({"telop": {"score": "abc", "action": "explode"}})
        assert r["telop"]["score"] == 0  # 採点不能でも数値（review_passedで比較できる）
        assert r["telop"]["action"] == "keep"
        assert r["illustration"]["score"] is None

    def test_score_clamped(self):
        r = normalize_review({"telop": {"score": 250}, "illustration": {"score": -5}})
        assert r["telop"]["score"] == 100
        assert r["illustration"]["score"] == 0


class TestReviewPassed:
    def test_pass_without_illustration(self):
        r = normalize_review({"telop": {"score": 80}, "illustration": {"score": None}})
        assert review_passed(r, 70)

    def test_fail_on_low_illustration(self):
        r = normalize_review({"telop": {"score": 90}, "illustration": {"score": 50}})
        assert not review_passed(r, 70)

    def test_fail_on_low_telop(self):
        r = normalize_review({"telop": {"score": 60}, "illustration": {"score": 90}})
        assert not review_passed(r, 70)
