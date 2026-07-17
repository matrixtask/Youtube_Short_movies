# pipeline/ — 編集パイプライン

撮りっぱなしの動画を入れると、ここまで全部自動でやります:

1. **文字起こし** — faster-whisper（単語タイムスタンプ付き）
2. **編集プラン** — Claudeが「どこを切り出すか / どこをカットするか / 字幕 /
   ツッコミ / 挿絵」をJSONで決める。ショートごとに0-100点で採点し、
   閾値未満はレンダリングしない（品質ゲート）
3. **変な間のカット** — 沈黙・言い直し・フィラーを刻んでテンポを作る
4. **挿絵** — Claudeが描くSVGイラストをPNG化して画面に重ねる
5. **レンダリング** — ffmpegで9:16・字幕焼き込みのショートを量産
6. **まとめ動画** — 溜まったショートをぼかし背景の16:9に繋いで1本に

## クラウド実行（推奨・PC不要）

このリポジトリのGitHub Actions（`.github/workflows/`）がパイプラインを
クラウドで実行します。やることはリポジトリの
Settings > Secrets and variables > Actions に4つのSecretsを入れるだけ:

| Secret | 内容 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude APIキー |
| `GAS_WEBAPP_URL` | GASのWebアプリURL |
| `GAS_ADMIN_TOKEN` | GASの `ADMIN_TOKEN` と同じ値 |
| `SLACK_BOT_TOKEN` | Slackボットトークン（files:read / files:write / chat:write） |

- **process-videos** — Slackに動画が届くとGASが即起動（`GITHUB_REPO`/`GITHUB_TOKEN`
  設定時）。保険として毎時も実行。生成したショートは元のスレッドに返り、
  台帳（Shortsシート）に登録される
- **compile** — Slackで「まとめて」と書くと起動（Actionsタブから手動でも可）。
  Slack上のショートを集めて1本にまとめ、チャプター付きでSlackに投稿

ランナーはCPUなので文字起こしは `medium` モデルを使います（ワークフローの
`YTSHORTS_WHISPER_MODEL` で変更可）。10分の動画で20分前後が目安です。

## ローカル実行（クラウドを使わない場合）

必要なもの: Python 3.10+ / ffmpeg / 日本語フォント（例: Noto Sans CJK）/ Claude APIキー

```bash
cd pipeline
pip install -e .          # ytshorts コマンドが入る
export ANTHROPIC_API_KEY=sk-ant-...
ytshorts init             # workspace/ と config.yaml を作る
```

GAS連携（Slackから取り込む場合）:

```bash
export GAS_ADMIN_TOKEN=...      # gas/ のADMIN_TOKENと同じ値
export SLACK_BOT_TOKEN=xoxb-... # 動画DL・ショートUP用
# config.yaml の gas_webapp_url にGASのWebアプリURLを設定
```

```bash
ytshorts pull                     # 新着を1回だけ取り込んで処理
ytshorts pull --watch             # 常駐（5分間隔で監視、Ctrl+Cで終了）
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
ytshorts list                     # ローカルストック一覧（スコア・秒数）
ytshorts compile                  # ローカルのショートを1本のまとめ動画に
ytshorts compile --from-slack     # Slack上のショートを材料に（クラウドと同じ動き）
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
