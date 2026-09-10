# HANDOFF.md — AI引き継ぎ資料

> **宛先**: このリポジトリを一時的に運用するAIアシスタント(ChatGPT等)へ。
> **書き手**: Claude (Fable 5)。ここまでの全システムを設計・実装した。
> **前提**: しばらく君が運用し、その後Claudeに戻る。だから「壊さない」「記録を残す」が最優先。

---

## 0. 最初の15分にやること(すべて読み取り専用)

```bash
cd ~/Youtube_Short_movies        # ユーザーのローカルPCでのパス
git pull
make help                        # 操作コマンド一覧
make test                        # pytest 132件が通ること
make dash                        # ダッシュボードが開くこと(開けばGASは健在)
```

- **動いているシステムである。** Slackに動画が投稿されると自動で編集が走り、承認するとYouTubeに投稿される。君が何もしなくても毎時cronが回っている。
- 変更を頼まれるまでは観察に徹すること。

## 1. プロジェクトは何か

**中井佑さん(teTra Aviation CEO、eVTOL開発)のYouTubeチャンネル「中井佑の、とにかく早く移動したい！」の全自動ショート量産システム。**

流れ: GASが毎朝Slackに撮影台本(質問+ネタ)を届ける → 本人が横型で撮影しSlackスレッドに動画を投稿 → パイプラインが文字起こし→変な間・言い直しをカット→字幕・ツッコミ・挿絵・タイトル帯を付けてショート量産(+16:9ワイド版) → Slackで承認(またはダッシュボード) → 投稿枠に自動スケジュールしてYouTubeへ → 再生数を取り込み自己反省して次の台本・編集を自動修正する。

## 2. アーキテクチャ(3層+2実行環境)

| 層 | 場所 | 役割 |
|---|---|---|
| **GAS** (`gas/src/`) | Google Apps Script | 司令塔。Slack Events受付、スプレッドシート=DB、台本生成、承認・投稿管理、ダッシュボード、自己分析 |
| **パイプライン** (`pipeline/`) | Python 3.11 | 編集の実働。faster-whisper文字起こし → Claude APIで編集プラン → ffmpegレンダリング → 見た目の自己採点 |
| **GitHub Actions** (`.github/workflows/`) | クラウド | パイプラインの実行環境その1。repository_dispatch + 毎時cron |
| ローカルGPU機 | ユーザーのPC | 実行環境その2。`make pull`で同じ処理を高速に |

- **排他制御**: 動画はGASの`claim_videos`(LockService)で「確保」してから処理。クラウドとGPU機が同時に走っても二重処理しない。90分放置されたclaimは自動でpendingに戻る。
- GASとパイプラインの通信は WebアプリURL への JSON POST/GET(`token`=ADMIN_TOKEN 必須)。

## 3. データモデル(スプレッドシート=DB)

シート定義は `gas/src/Sheets.js` の `SHEET_HEADERS` が唯一の真実。
**ヘッダー行は読み取り時に自動同期される**(列を足したら定義に追加するだけ。手動セットアップ不要)。定義に無い列を手で足さないこと。

| シート | 役割 | status遷移 |
|---|---|---|
| Scripts | 撮影台本(1回=1行) | `open`(撮影待ち) → `shot`(撮影済) → `done` / `expired` |
| Questions | 台本内の質問(1問=1行) | — |
| Videos | 投稿された動画の処理キュー | `pending` → `processing`(claim中) → `done` / `failed`。再編集で`pending`に戻る |
| Shorts | 生成済みショート台帳(実体はSlack上のファイル) | `stock`(承認待ち) → `approved` → `scheduled`(投稿枠割当) → `published` / `rejected` / `failed` |
| Themes | トークテーマと重み(自己調整される) | weight 0 = 休止 |
| Insights | 自己分析の所見・修正方針の履歴 | — |
| Log | イベントログ。**デバッグは必ずここから見る** | — |

## 4. SlackコマンドAPI(これがユーザーとの接点。全一覧)

チャンネル直下:
| 発言 | 動作 |
|---|---|
| `台本` (撮影/インタビュー/script) | 臨時の撮影台本を生成 |
| `まとめて` (まとめ/compile) | ショートからまとめ動画を生成 |
| `承認 <コード>` / `承認 全部` / `却下 <コード>` | ショートの承認・却下 |

台本・動画スレッド内:
| 発言 | 動作 |
|---|---|
| 動画ファイルを投稿 | 編集キューに入り自動処理(受付ackに動画コードが出る) |
| `撮った` (撮影した/終了/done) | 台本を撮影済みにする |
| `再編集 <指示>` / `再編集 <コード> <指示>` | その動画を新指示で編集し直し |
| `リテイク` | 台本を作り直し |
| 上記以外の発言 | メモとして保存→次回の台本生成のヒント |

ボットからの応答: 受付📥 → 編集開始⚙️(ワーカー名と指示が出る) → 完了✨/失敗⚠️ → 承認依頼⏳ → 投稿完了🎬。**無反応=異常**。Logシートを見る。

## 5. ダッシュボード(Web UI)

- URL: `<GAS WebアプリURL>?token=<ADMIN_TOKEN>&page=dash`(ローカルなら `make dash`)
- タブ: ⏳承認待ち / 📅投稿予約 / 📺投稿済み / 🎥動画 / 📊分析
- できること: 個別・一括の承認/却下/🚀今すぐ投稿、再編集指示の送信、再生数更新、自己分析の実行
- サムネはパイプラインがシートに保存したdata URI(旧データはSlackサムネにフォールバック)
- 実装は `gas/src/Dashboard.js` 1ファイル。ボタンは `google.script.run` → 各関数の先頭で必ず `requireDashToken(token)`。**この検証を外さないこと**(Webアプリは全員公開)

## 6. 自己改善ループ(このシステムの核。壊すと価値が半減する)

1. **テーマ重み調整** (`gas/src/Themes.js`): 週次で、撮られなかった/飛ばされたテーマの重みを半減、喋れたテーマを増強。
2. **傾向の言語化** (`THEME_INSIGHTS`プロパティ): 類似テーマで「喋れた/喋れなかった」を比較し差分を抽出、未検証テーマへ先回り適用。台本の聞き方に反映。
3. **再生実績の自己反省** (`gas/src/Analytics.js`, 週次+手動): YouTube再生数を取り込み、質問/ネタ/構成の修正方針を生成 → `SCRIPT_INSIGHTS`プロパティ → 台本生成と編集プラン(claim時にパイプラインへ配布)の両方に自動注入。履歴はInsightsシート。
4. **見た目の自己採点** (`pipeline/ytshorts/review.py`): レンダリング後にvisionでテロップ・挿絵を採点(合格70点)。不合格なら文字サイズ/位置調整・挿絵の描き直しで最大2回再レンダリング。サムネは候補フレームを採点して最良を採用。`config.yaml`の`visual_review: false`で無効化可。

## 7. 秘密情報の所在(対応表。**これ以外の場所に置かない・コミットしない**)

| 置き場所 | 内容 |
|---|---|
| **GASスクリプトプロパティ** | ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, ADMIN_TOKEN, SPREADSHEET_ID, WEBAPP_URL, GITHUB_REPO, GITHUB_TOKEN, YT_CLIENT_ID/SECRET/REFRESH_TOKEN, NOTION_TOKEN ほか(全一覧は`gas/src/Config.js`冒頭コメント) |
| **ローカル `.env`** (git管理外) | 同じ値。ただし命名が違うものがある: GASの`ADMIN_TOKEN` = .envの`GAS_ADMIN_TOKEN`、WebアプリURLは`YTSHORTS_GAS_WEBAPP_URL` |
| **GitHub Secrets** | ANTHROPIC_API_KEY, GAS_WEBAPP_URL, GAS_ADMIN_TOKEN, SLACK_BOT_TOKEN, YT_CLIENT_ID/SECRET/REFRESH_TOKEN |

- `.env`が壊れたら `make env-pull`(GASから収集して検証つきで再生成。GAS側で一時的に`ALLOW_ENV_EXPORT=true`が要る。終わったら消す)
- トークンを変えたら**3箇所すべて**を同じ値にする。片方だけ変えると`unauthorized`で静かに死ぬ(過去にやった)。

## 8. 定常運用コマンド

```bash
make dash        # ダッシュボードを開く
make pull        # Slackの新着動画を取り込んで処理(GPU機での手動処理)
make watch       # 同上を5分間隔で常駐
make gas-deploy  # GASコード反映+Webアプリ再デプロイ(URLは変わらない)
make test        # pytest(コード変更したら必ず)
make gpu-check   # GPUが効いているか確認
```

**GASを変更したら**: `make gas-deploy`(未デプロイだと本番は旧コードのまま。「直したのに変わらない」の原因第1位)。
**pipeline/config.yamlの変更**: コミットするだけでクラウドに反映(Actionsはリポジトリから読む)。

## 9. やってはいけないこと(全部、実際に事故った理由つき)

1. **`clasp clone`を実行しない。** ローカルのgas/を上書きし、appsscript.jsonのWebアプリ設定を破壊した前科がある。紐づけは`make gas-link`(.clasp.jsonを書くだけ)。
2. **GASのWebアプリデプロイを削除・新規作成しない。** URLが変わるとSlack Events・GitHub Secrets・.envすべてが死ぬ。更新は必ず既存デプロイのID(`GAS_DEPLOYMENT_ID`)への上書き(`make gas-deploy`がやる)。
3. **シークレットをコミット・チャット貼り付けしない。** 過去にADMIN_TOKENがチャットに露出してローテーションした。
4. **claim機構を迂回して動画を直接処理しない。** GPU機とクラウドの二重処理になる。入口は必ず`make pull` / Actionsの`ytshorts pull`。
5. **`SHEET_HEADERS`と実シートを手で不一致にしない。** 書き込みはコード定義の列位置、読み取りは実ヘッダー。ズレると「書けてるのに読めない」静かなデータ喪失になる(自動同期があるので触らなければ安全)。
6. **YouTube投稿は1日約6本まで**(APIクォータ)。「全部今すぐ投稿」を無邪気に押さない。超過分はfailedでシートに残るので翌日再投稿すればよい。

## 10. ユーザー(中井さん)との仕事の仕方

- 日本語。指示は短い。技術理解が深く意思決定が速い。**「〜しますか?」と聞きすぎない**。可逆な作業は先にやって結果で報告する。不可逆(削除・外部公開・課金)だけ確認。
- 「**マージして**」= workブランチ(`claude/youtube-short-auto-pipeline-d1z54a`)と`main`の**両方**にpushする、が確立した意味。
- エラー報告はスクショや貼り付けで来る。まずLogシート(GAS)とActionsのログで裏を取る。
- 現場はUbuntu 2台(片方GPU)。ディレクトリは`~/Youtube_Short_movies`。

## 11. Git運用と署名

- 開発は`claude/youtube-short-auto-pipeline-d1z54a`で行い、「マージして」で両ブランチへpush。リポジトリは`matrixtask/Youtube_Short_movies`(旧名Shrotからリネーム済み。リモートURLの警告は無害)。
- **署名**: 君はClaudeではない。コミットの`Co-Authored-By: Claude ...`署名は**使わない**こと。自分のアシスタント名で署名するか、無署名で。Claudeの署名が付いた過去コミットはClaudeの作業履歴なので、履歴改変もしない。

## 12. Claudeに戻る日のために(重要)

- **君が行った変更は、このファイル末尾の「引き継ぎログ」に追記すること。** 1変更=1行(日付/何を/なぜ/どのコミット)。Claudeは復帰時にまずここを読む。
- 大きな設計変更(新シート、新プロパティ、フロー変更)は該当ファイルの冒頭コメントも更新する。
- 未解決のまま渡す問題は「持ち越し」に書く。

### 持ち越し(2026-09-10時点)
- GitHubのデフォルトブランチをmainに切替+不要ブランチ削除(ユーザー作業、未確認)
- YouTube投稿のend-to-end(承認→スロット→アップロード)は仕組み完成、実投稿での検証回数が少ない
- Notion同期(`nightlyNotionSync`)はプロパティ設定に依存。トークテーマDB: data_source `40b07b00-9eac-4cfa-bd6f-e67805190198`
- 見た目自己採点(visual_review)は導入直後。採点の厳しさ・コストは実運用で要調整

### 引き継ぎログ
- 2026-09-10 Claude: 本引き継ぎ資料を作成。ここまでの実装は`git log`参照。

---
*質問があればユーザーに聞くより先に、コード・Logシート・このファイルを読むこと。それでも分からないことだけ聞く。健闘を祈る。 — Claude*
