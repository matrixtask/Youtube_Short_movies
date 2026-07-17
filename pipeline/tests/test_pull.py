from ytshorts.pull import safe_filename


class TestSafeFilename:
    def test_plain_name(self):
        assert safe_filename("IMG_1234.MOV") == "IMG_1234.mov"

    def test_japanese_kept(self):
        assert safe_filename("撮影 テスト!?.mp4") == "撮影_テスト.mp4"

    def test_path_traversal_stripped(self):
        assert safe_filename("../../etc/passwd.mp4") == "passwd.mp4"

    def test_no_extension_defaults_mp4(self):
        assert safe_filename("video") == "video.mp4"

    def test_empty_uses_fallback(self):
        assert safe_filename("", fallback="vid_123") == "vid_123.mp4"

    def test_weird_extension_sanitized(self):
        assert safe_filename("a.M P4") == "a.mp4"
