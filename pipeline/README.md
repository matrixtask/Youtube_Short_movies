# pipeline/ — 編集パイプライン（ローカル実行）

撮りっぱなしの動画を入れると、ここまで全部自動でやります:

1. **文字起こし** — faster-whisper（単語タイムスタンプ付き）
2. **編集プラン** — Claudeが「どこを切り出すか / どこをカットするか / 字幕 /
   ツッコミ / 挿絵」をJSONで決める。ショートごとに0-100点で採点し、
   閾値未満はレンダリングしない（品質ゲート）
3. **変な間のカット** — 沈黙・言い直し・フィラーを刻んでテンポを作る
4. **挿絵** — Claudeが描くSVGイラストをPNG化して画面に重ねる
5. **レンダリング** — ffmpegで9:16・字幕焼き込みのショートを量産
6. **まとめ動画** — 溜まったショートをぼかし背景の16:9に繋いで1本に

## セットアップ

必要なもの: Python 3.10+ / ffmpeg / Claude APIキー

```bash
cd pipeline
pip install -e .          # ytshorts コマンドが入る
export ANTHROPIC_API_KEY=sk-ant-...
ytshorts init             # workspace/ と config.yaml を作る
```

GAS撮影台本システムと連携する場合（任意）:

```bash
export GAS_ADMIN_TOKEN=...   # gas/ のADMIN_TOKENと同じ値
# config.yaml の gas_webapp_url にGASのWebアプリURLを設定
```

連携すると、編集プランに「どの質問に答えた動画か」の文脈が入り、
処理結果がSlackに通知され、台本のステータスが自動で更新されます。

## 使い方

```bash
# 撮った動画を workspace/inbox/ に入れて
ytshorts run                      # inbox内すべてを処理
ytshorts run 20260717.mp4         # ファイル指定でもOK
ytshorts run --force              # 文字起こし・プランを作り直す

ytshorts list                     # ストック一覧（スコア・秒数）
ytshorts compile                  # 全部を1本のまとめ動画に
ytshorts compile --min-score 80 --limit 10
```

- ショートは `workspace/shorts/` に、まとめ動画は `workspace/compilations/`
  に出力されます（概要欄用のチャプターリスト付き）
- 中間生成物（文字起こし・プラン・挿絵・字幕）は `workspace/sessions/<動画名>/`
  に残るので、`plan.json` を手で直して `ytshorts run` し直すこともできます

## テスト

```bash
pip install pytest
pytest
```

ネットワーク・ffmpeg不要の純粋ロジック（カット計算・プラン正規化・字幕生成・
ffmpegコマンド組み立て）をテストしています。
