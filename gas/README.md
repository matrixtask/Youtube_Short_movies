# gas/ — 撮影台本システム（Google Apps Script）

毎朝Slackに「撮影台本」（質問＋ネタ指示）を届け、動画の受付・承認・
YouTube投稿スケジュールを司る部分です。X_Autopost と同じ
GAS + スプレッドシート + Slack の構成で、サーバー運用は不要です。

> **まずはリポジトリルートの `python3 setup/setup.py`（ウィザード）を推奨。**
> 以下はウィザードが内部でやっていることの手動版です。

## セットアップ

### 1. GASプロジェクト

1. [script.google.com](https://script.google.com) で新規プロジェクトを作成し、
   `src/` 以下のファイルをコピペで貼り付ける（clasp なら
   `.clasp.json.example` を `.clasp.json` にコピーして `clasp push`）
2. スプレッドシートは不要 — `setupAll()` 実行時に自動作成されます
   （既存を使う場合のみ `SPREADSHEET_ID` を設定）

### 2. スクリプトプロパティ

GASエディタ > プロジェクトの設定 > スクリプト プロパティに設定:

| キー | 内容 |
|---|---|
| `SPREADSHEET_ID` | 既存シートを使う場合のみ（未設定なら自動作成） |
| `ANTHROPIC_API_KEY` | Claude APIキー |
| `SLACK_BOT_TOKEN` | Slackボットトークン (`xoxb-...`) |
| `SLACK_CHANNEL_ID` | 台本を届けるチャンネルID |
| `ADMIN_TOKEN` | ローカルパイプライン連携用の長いランダム文字列 |
| `SHOOT_QUESTIONS` | 質問数（任意、既定5） |
| `SHOOT_DAYS` | 撮影日 `MON,WED,FRI` など（任意、空なら毎日） |
| `SHOOT_HOUR` | 届く時刻（任意、既定8時台） |
| `GITHUB_REPO` | クラウド実行用 `owner/repo`（任意。設定すると動画到着で即Actions起動） |
| `GITHUB_TOKEN` | `repository_dispatch` を送れる fine-grained PAT（任意） |
| `AUTO_APPROVE` | `true` で承認なしにYouTube投稿枠へ（任意、既定false） |
| `YOUTUBE_SLOT_TIMES` | 1日の投稿枠 `08:00,19:00`（任意、既定） |
| `MAX_UPLOADS_PER_DAY` | 1日の最大投稿数（任意、既定2） |
| `YOUTUBE_PRIVACY` | `public` / `unlisted` / `private`（任意、既定public） |

SlackアプリはX_Autopostと同じものを使い回せます（別チャンネルにするだけ）。
Bot Token Scopes は `chat:write` / `channels:history`（イベント購読に必須）に
加えて **`files:read`**（動画のダウンロード）と
**`files:write`**（生成したショートをスレッドに返すのに必要）。
Event Subscriptions で `message.channels` を購読し、ボットをチャンネルに招待。
動画アップロードのイベントも `message.channels`（subtype: file_share）で届くので
追加の購読は不要です。

`GITHUB_REPO` / `GITHUB_TOKEN` を設定しない場合でも、GitHub Actionsの毎時の
定期実行（またはローカルの `ytshorts pull`）が処理を拾います。設定すると
動画が届いた瞬間・「まとめて」と書いた瞬間にクラウド処理が始まります。

### 3. 初期化

GASエディタから `setupAll()` を実行するだけ（スプレッドシート自動作成＋
シート初期化＋トリガー登録＋Slackテスト通知まで一括）。
ウィザードを使った場合は、その前に `applyLocalProps()` を実行して
プロパティを流し込みます。

Slackアプリは `setup/slack-app-manifest.yaml` を
[api.slack.com/apps](https://api.slack.com/apps) の「Create New App > From a
manifest」に貼れば、スコープ・イベント購読込みで一発で作れます。

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
- ショートごとに承認依頼が届く → **「承認 xxxx」/「却下 xxxx」/「承認 全部」**
  と返信（スレッド内でもチャンネル直下でもOK）。承認分は毎時の `youtubeTick` が
  投稿枠に割り当て、時間が来るとYouTubeへ自動投稿されて結果URLが届く
- チャンネルに **「まとめて」** と書くと、溜まったショートからまとめ動画が作られて届く
- 「リテイク」→ 台本を作り直す
- チャンネルに「台本」と書くと追加の台本がいつでももらえる
- それ以外の返信はメモとして保存され、次の台本生成のヒントになる

動画の実処理はGitHub Actions（クラウド）またはローカルPCの
`ytshorts pull --watch` が行います。[../pipeline/README.md](../pipeline/README.md) を参照。

## Notion連携（任意）

トークテーマとショート台帳をNotionのWikiに同期できます（毎晩22時台+手動）:

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) でインテグレーションを作成し、
   シークレットをスクリプトプロパティ `NOTION_TOKEN` に設定
2. Wikiにする親ページの右上「…」→「コネクト」でインテグレーションを追加
3. ページURL末尾の32桁IDを `NOTION_PARENT_PAGE_ID` に設定
4. GASエディタで `setupNotionDatabases()` を実行 →
   「トークテーマ」「ショート台帳」のデータベースが自動作成される
5. `installTriggers()` を再実行（毎晩の同期トリガーが追加される）

同期はシート→Notionの一方向です。テーマの編集はThemesシートで。

## Themesシート

質問のテーマプールです。`theme / category (evergreen|news|neta) / weight /
notes` を編集して自分の話したいネタに育ててください。直近3日で使ったテーマは
出にくくなります。
