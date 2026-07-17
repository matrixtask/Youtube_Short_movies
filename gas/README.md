# gas/ — 撮影台本システム（Google Apps Script）

毎朝Slackに「撮影台本」（質問＋ネタ指示）を届ける部分です。X_Autopost と同じ
GAS + スプレッドシート + Slack の構成で、サーバー運用は不要です。

## セットアップ

### 1. スプレッドシートとGASプロジェクト

1. Googleスプレッドシートを新規作成し、IDを控える（URLの `/d/` と `/edit` の間）
2. [script.google.com](https://script.google.com) で新規プロジェクトを作成
3. `src/` 以下のファイルをコピペで貼り付ける（clasp を使うなら
   `.clasp.json.example` を `.clasp.json` にコピーして `clasp push`）

### 2. スクリプトプロパティ

GASエディタ > プロジェクトの設定 > スクリプト プロパティに設定:

| キー | 内容 |
|---|---|
| `SPREADSHEET_ID` | 手順1のスプレッドシートID |
| `ANTHROPIC_API_KEY` | Claude APIキー |
| `SLACK_BOT_TOKEN` | Slackボットトークン (`xoxb-...`) |
| `SLACK_CHANNEL_ID` | 台本を届けるチャンネルID |
| `ADMIN_TOKEN` | ローカルパイプライン連携用の長いランダム文字列 |
| `SHOOT_QUESTIONS` | 質問数（任意、既定5） |
| `SHOOT_DAYS` | 撮影日 `MON,WED,FRI` など（任意、空なら毎日） |
| `SHOOT_HOUR` | 届く時刻（任意、既定8時台） |
| `GITHUB_REPO` | クラウド実行用 `owner/repo`（任意。設定すると動画到着で即Actions起動） |
| `GITHUB_TOKEN` | `repository_dispatch` を送れる fine-grained PAT（任意） |

SlackアプリはX_Autopostと同じものを使い回せます（別チャンネルにするだけ）。
Bot Token Scopes は `chat:write` に加えて **`files:read`**（動画のダウンロード）と
**`files:write`**（生成したショートをスレッドに返すのに必要）。
Event Subscriptions で `message.channels` を購読し、ボットをチャンネルに招待。
動画アップロードのイベントも `message.channels`（subtype: file_share）で届くので
追加の購読は不要です。

`GITHUB_REPO` / `GITHUB_TOKEN` を設定しない場合でも、GitHub Actionsの毎時の
定期実行（またはローカルの `ytshorts pull`）が処理を拾います。設定すると
動画が届いた瞬間・「まとめて」と書いた瞬間にクラウド処理が始まります。

### 3. 初期化

GASエディタから順に実行:

1. `setupSpreadsheet()` — シート作成＋テーマ初期データ投入
2. `installTriggers()` — 毎朝の台本トリガー＋週次サマリーを登録

### 4. Webアプリのデプロイ

デプロイ > 新しいデプロイ > ウェブアプリ（実行ユーザー: 自分 / アクセス: 全員）。

- デプロイURLを SlackアプリのEvent Subscriptions の Request URL に設定
- 同じURLをスクリプトプロパティ `WEBAPP_URL` と、ローカルの
  `pipeline/config.yaml` の `gas_webapp_url` に設定

## 日々の使い方

- 朝、Slackに台本が届く → スマホで縦画面のまま1問ずつ答える動画を撮る
- **撮った動画を台本のスレッドにそのまま投稿** → 編集キューに登録され、
  台本と自動で紐づく。**できあがったショートが同じスレッドに返ってくる**
  （チャンネル直下に投稿した場合は最新の台本に紐づきます）
- チャンネルに **「まとめて」** と書くと、溜まったショートからまとめ動画が作られて届く
- 「リテイク」→ 台本を作り直す
- チャンネルに「台本」と書くと追加の台本がいつでももらえる
- それ以外の返信はメモとして保存され、次の台本生成のヒントになる

動画の実処理はGitHub Actions（クラウド）またはローカルPCの
`ytshorts pull --watch` が行います。[../pipeline/README.md](../pipeline/README.md) を参照。

## Themesシート

質問のテーマプールです。`theme / category (evergreen|news|neta) / weight /
notes` を編集して自分の話したいネタに育ててください。直近3日で使ったテーマは
出にくくなります。
