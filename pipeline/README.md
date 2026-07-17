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

GAS撮影台本システムと連携する場合（Slackに投げるだけの完全自動化。推奨）:

```bash
export GAS_ADMIN_TOKEN=...    # gas/ のADMIN_TOKENと同じ値
export SLACK_BOT_TOKEN=xoxb-... # 動画ダウンロード用（files:read 権限）
# config.yaml の gas_webapp_url にGASのWebアプリURLを設定
```

## 使い方

### Slack完結モード（推奨）

スマホで撮った動画をSlackの台本スレッドに投稿するだけ。PC側は常駐の
`pull` が新着を検知して、ダウンロード→編集→結果をスレッドに返します。

```bash
ytshorts pull                     # 新着を1回だけ取り込んで処理
ytshorts pull --watch             # 常駐（5分間隔で監視、Ctrl+Cで終了）
ytshorts pull --watch --interval 60
```

cronで回す場合（常駐の代わり）:

```cron
*/10 * * * * cd ~/Youtube_Shrot_movies/pipeline && ANTHROPIC_API_KEY=... GAS_ADMIN_TOKEN=... SLACK_BOT_TOKEN=... ytshorts pull >> pull.log 2>&1
```

### 手動モード（GASなしでも動く）

```bash
# 撮った動画を workspace/inbox/ に入れて
ytshorts run                      # inbox内すべてを処理
ytshorts run 20260717.mp4         # ファイル指定でもOK
ytshorts run --force              # 文字起こし・プランを作り直す
```

### ストックとまとめ動画

```bash
ytshorts list                     # ストック一覧（スコア・秒数）
ytshorts compile                  # 全部を1本のまとめ動画に
ytshorts compile --min-score 80 --limit 10
```

Slackのファイル上限は1ファイル1GBです。4Kで長回しして超える場合は
1080pで撮るか、手動モード（inbox）を使ってください。

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
