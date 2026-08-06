"""config.py — 設定の読み込みとワークスペースのパス。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

CONFIG_FILENAME = "config.yaml"


@dataclass
class Config:
    workspace: Path = Path("workspace")
    # 文字起こし
    whisper_model: str = "large-v3"
    whisper_device: str = "auto"
    language: str = "ja"
    # 編集
    claude_model: str = "claude-sonnet-5"
    max_pause: float = 0.5  # これを超える沈黙はカット
    pad: float = 0.15  # 発話の前後に残す秒数
    short_min_sec: float = 15.0
    short_max_sec: float = 59.0
    quality_threshold: int = 70  # このスコア未満のショートはレンダリングしない
    # 見た目の自己採点（レンダリング後にvisionでテロップ・挿絵・サムネを採点）
    visual_review: bool = True
    visual_threshold: int = 70  # この点未満は再生成・調整して作り直す
    visual_max_retries: int = 2  # 作り直しの上限回数（コストと時間の歯止め）
    # チャンネル・テイスト
    channel_concept: str = "中井佑の、とにかく早く移動したい！"
    style_notes: str = ""  # 編集テイストの指示（字幕の口調・ツッコミの温度感など）
    # 出力
    width: int = 1080
    height: int = 1920
    fps: int = 30
    wide_enabled: bool = True  # 横型ソースのとき16:9ワイド版も生成（まとめ・ロング用）
    shorts_layout: str = "fit"  # 横型ソースのショート化: fit=横幅フィット+上下帯 / crop=中央切り抜き
    band_color: str = "#101820"  # fitレイアウトの帯の色
    # 字幕スタイル
    subtitle_font: str = "Noto Sans CJK JP"
    caption_color: str = "#FFFFFF"
    hook_color: str = "#FFE600"
    tsukkomi_color: str = "#FFD700"
    title_color: str = "#FFFFFF"  # fitレイアウトの上帯タイトル
    # レイアウト位置（すべて画面に対する比率 0〜1）
    text_side: str = "center"  # テロップの寄せ: center / left / right（話者と反対側に）
    caption_margin: float = 0.177  # 本文字幕の下からの余白
    tsukkomi_margin: float = 0.365  # ツッコミ字幕の上からの余白
    caption_fontsize: int = 72  # 本文字幕の文字サイズ（1080幅基準）
    video_y: float = 0.42  # fitレイアウトの映像の縦位置（0=上寄せ 0.5=中央）
    illustration_width: float = 0.8  # 挿絵の幅（短辺に対する比率）
    illustration_x: float = 0.5  # 挿絵の中心の横位置（左から）
    illustration_y: float = 0.38  # 挿絵の中心の縦位置（上から）
    # GAS連携（任意）
    gas_webapp_url: str = ""
    gas_admin_token: str = ""

    @property
    def inbox(self) -> Path:
        return self.workspace / "inbox"

    @property
    def sessions(self) -> Path:
        return self.workspace / "sessions"

    @property
    def shorts_dir(self) -> Path:
        return self.workspace / "shorts"

    @property
    def compilations_dir(self) -> Path:
        return self.workspace / "compilations"

    def ensure_dirs(self) -> None:
        for d in (self.inbox, self.sessions, self.shorts_dir, self.compilations_dir):
            d.mkdir(parents=True, exist_ok=True)


def load_config(path: str | Path | None = None) -> Config:
    """config.yaml を読む。無ければ既定値。環境変数 YTSHORTS_* が優先。"""
    cfg = Config()
    p = Path(path) if path else Path(CONFIG_FILENAME)
    if p.exists():
        data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        for key, value in data.items():
            if not hasattr(cfg, key):
                continue
            current = getattr(cfg, key)
            setattr(cfg, key, Path(value) if isinstance(current, Path) else type(current)(value))
    if os.environ.get("YTSHORTS_WORKSPACE"):
        cfg.workspace = Path(os.environ["YTSHORTS_WORKSPACE"])
    if os.environ.get("GAS_ADMIN_TOKEN"):
        cfg.gas_admin_token = os.environ["GAS_ADMIN_TOKEN"]
    # クラウド実行（GitHub Actions）ではconfig.yamlを持たないため環境変数で渡す
    if os.environ.get("YTSHORTS_GAS_WEBAPP_URL"):
        cfg.gas_webapp_url = os.environ["YTSHORTS_GAS_WEBAPP_URL"]
    if os.environ.get("YTSHORTS_WHISPER_MODEL"):
        cfg.whisper_model = os.environ["YTSHORTS_WHISPER_MODEL"]
    return cfg
