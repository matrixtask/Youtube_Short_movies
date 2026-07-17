from ytshorts.planner import normalize_plan


def make_short(**over):
    s = {
        "id": "s1",
        "title": "テスト",
        "hook": "フック",
        "clip": {"start": 10.0, "end": 50.0},
        "extra_cuts": [{"start": 20.0, "end": 21.0, "reason": "言い直し"}],
        "captions": [{"start": 11.0, "end": 13.0, "text": "こんにちは"}],
        "overlays": [{"time": 30.0, "duration": 2.0, "text": "ツッコミ"}],
        "illustrations": [{"time": 40.0, "duration": 3.0, "prompt": "空飛ぶクルマ"}],
        "score": 85,
        "score_reason": "良い",
    }
    s.update(over)
    return s


class TestNormalizePlan:
    def test_valid_plan_passes_through(self):
        plan = normalize_plan({"shorts": [make_short()]}, duration=100.0)
        assert len(plan["shorts"]) == 1
        s = plan["shorts"][0]
        assert s["clip"] == {"start": 10.0, "end": 50.0}
        assert s["score"] == 85

    def test_clip_clamped_to_duration(self):
        plan = normalize_plan({"shorts": [make_short(clip={"start": -5, "end": 999})]}, 60.0)
        assert plan["shorts"][0]["clip"] == {"start": 0.0, "end": 60.0}

    def test_too_short_clip_dropped(self):
        plan = normalize_plan({"shorts": [make_short(clip={"start": 10, "end": 11})]}, 60.0)
        assert plan["shorts"] == []

    def test_broken_clip_dropped(self):
        plan = normalize_plan({"shorts": [make_short(clip=None), make_short(id="s2")]}, 100.0)
        assert [s["id"] for s in plan["shorts"]] == ["s2"]

    def test_times_clamped_into_clip(self):
        s = make_short(
            captions=[{"start": 0.0, "end": 200.0, "text": "はみ出し"}],
            overlays=[{"time": 999.0, "text": "外"}],
        )
        plan = normalize_plan({"shorts": [s]}, 300.0)
        cap = plan["shorts"][0]["captions"][0]
        assert cap["start"] == 10.0 and cap["end"] == 50.0
        assert plan["shorts"][0]["overlays"][0]["time"] == 50.0

    def test_empty_caption_text_dropped(self):
        s = make_short(captions=[{"start": 11, "end": 12, "text": "  "}])
        plan = normalize_plan({"shorts": [s]}, 100.0)
        assert plan["shorts"][0]["captions"] == []

    def test_captions_sorted(self):
        s = make_short(captions=[
            {"start": 30, "end": 32, "text": "後"},
            {"start": 11, "end": 13, "text": "先"},
        ])
        plan = normalize_plan({"shorts": [s]}, 100.0)
        assert [c["text"] for c in plan["shorts"][0]["captions"]] == ["先", "後"]

    def test_missing_fields_get_defaults(self):
        plan = normalize_plan({"shorts": [{"clip": {"start": 0, "end": 30}}]}, 60.0)
        s = plan["shorts"][0]
        assert s["id"] == "s1"
        assert s["score"] == 0
        assert s["extra_cuts"] == [] and s["overlays"] == []

    def test_bad_score_becomes_zero(self):
        plan = normalize_plan({"shorts": [make_short(score="高い")]}, 100.0)
        assert plan["shorts"][0]["score"] == 0

    def test_overlay_duration_clamped(self):
        s = make_short(overlays=[{"time": 30, "duration": 60, "text": "長い"}])
        plan = normalize_plan({"shorts": [s]}, 100.0)
        assert plan["shorts"][0]["overlays"][0]["duration"] == 6.0

    def test_no_shorts_key(self):
        assert normalize_plan({}, 60.0) == {"shorts": []}
