from ytshorts.youtube import MAX_TITLE_LEN, build_video_body, youtube_title


class TestYoutubeTitle:
    def test_appends_shorts_hashtag(self):
        assert youtube_title("失敗談") == "失敗談 #Shorts"

    def test_angle_brackets_replaced(self):
        # YouTubeのタイトルは <> を受け付けない
        assert "<" not in youtube_title("a<b>c")
        assert youtube_title("a<b>c") == "a＜b＞c #Shorts"

    def test_long_title_truncated(self):
        t = youtube_title("あ" * 200)
        assert len(t) <= MAX_TITLE_LEN
        assert t.endswith(" #Shorts")
        assert "…" in t


class TestBuildVideoBody:
    def test_basic_structure(self):
        body = build_video_body("タイトル", "説明", "public")
        assert body["snippet"]["title"] == "タイトル #Shorts"
        assert body["snippet"]["description"] == "説明"
        assert body["status"]["privacyStatus"] == "public"
        assert body["status"]["selfDeclaredMadeForKids"] is False

    def test_invalid_privacy_falls_back_to_private(self):
        body = build_video_body("t", "d", "everyone")
        assert body["status"]["privacyStatus"] == "private"
