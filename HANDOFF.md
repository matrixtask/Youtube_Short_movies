# HANDOFF.md — AI引き継ぎ資料

> **2026-09-11 最新**: Astra対応と採用企画改善は `b0496d6` までmain/既存作業ブランチへ反映済み。今回の撮影カード実装は下記「撮影カードへの反映」を参照。GASは運用機でのデプロイが別途必要。下記の過去ログにある「未push」は当時の状態。仕様は [SCRIPT_GUIDE.md](SCRIPT_GUIDE.md)、[SCRIPT_CARD_DESIGN.md](SCRIPT_CARD_DESIGN.md)、キー設定は [ASTRA_SETUP.md](ASTRA_SETUP.md)。

> **宛先**: このリポジトリを一時的に運用するAIアシスタント(ChatGPT等)へ。
> **書き手**: Claude (Fable 5)。ここまでの全システムを設計・実装した。
> **前提**: しばらく君が運用し、その後Claudeに戻る。だから「壊さない」「記録を残す」が最優先。

---

## 0. 最初の15分にやること(すべて読み取り専用)

```bash
cd ~/Youtube_Short_movies        # ユーザーのローカルPCでのパス
git pull
make help                        # 操作コマンド一覧
make test                        # pytest 154件（撮影カード対応を含む）
node --test gas/tests/*.test.cjs   # GAS 69件（Node.js 24）
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
| **パイプライン** (`pipeline/`) | Python 3.10+（Actionsは3.12） | 編集の実働。faster-whisper文字起こし → Astra/Claude APIでテーマ・編集プラン → ffmpegレンダリング → 見た目の自己採点 |
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
| **GASスクリプトプロパティ** | OPENAI_API_KEY（または従来のANTHROPIC_API_KEY）, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, ADMIN_TOKEN, SPREADSHEET_ID, WEBAPP_URL, GITHUB_REPO, GITHUB_TOKEN, YT_CLIENT_ID/SECRET/REFRESH_TOKEN, NOTION_TOKEN ほか(全一覧は`gas/src/Config.js`冒頭コメント) |
| **ローカル `.env`** (git管理外) | 同じ値。ただし命名が違うものがある: GASの`ADMIN_TOKEN` = .envの`GAS_ADMIN_TOKEN`、WebアプリURLは`YTSHORTS_GAS_WEBAPP_URL` |
| **GitHub Secrets** | OPENAI_API_KEY（または従来のANTHROPIC_API_KEY）, GAS_WEBAPP_URL, GAS_ADMIN_TOKEN, SLACK_BOT_TOKEN, YT_CLIENT_ID/SECRET/REFRESH_TOKEN |

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
- **Astraの実機確認が最優先。** ユーザーは `OPENAI_API_KEY` をGASとGitHub Actionsの両方へ登録済みと報告。GitHub側はSecret名と登録時刻のみ確認済み、GAS側の値・接続は未確認。ローカルを使う場合は `.env` にも登録する。実API呼出し・課金・実動画編集はこの作業では未実施。`ASTRA_SETUP.md` の `ai-check` で利用権限を確認後、実素材1本でテーマ・字幕・カット・見た目と応答時間を検証する。Windows作業環境にはffmpegがPATH上になく、テストはAPI/描画をスタブ化した検証。
- GitHubのデフォルトブランチは2026-09-10に `gh repo view` で `main` と確認済み。不要ブランチ削除の要否は未確認・未実施。
- YouTube投稿のend-to-end(承認→スロット→アップロード)は仕組み完成、実投稿での検証回数が少ない
- Notion同期(`nightlyNotionSync`)はプロパティ設定に依存。トークテーマDB: data_source `40b07b00-9eac-4cfa-bd6f-e67805190198`
- 見た目自己採点(visual_review)は導入直後。採点の厳しさ・コストは実運用で要調整
- **優先: 修正の本番反映と確認。** `5197a46` の一括操作修正はローカルのみ。既存の `GAS_DEPLOYMENT_ID` に `make gas-deploy` で反映し、GAS実環境を確認する必要がある。このWindows作業コピーには `.env` / `gas/.clasp.json` がなく、Logシート・ダッシュボード・実投稿は未検証。
- **次の改善候補: 投稿の重複防止。** `gas/src/Publish.js:listPublishQueue()` は取得時に確保しない。Actions内のconcurrencyはあるが、ローカル `make publish` と同時実行すると同じ動画を投稿し得る（コード上のリスク、事故発生は未確認）。投稿用claimと復旧手順を検討する。
- **次の改善候補: 投稿成功と結果報告失敗の分離。** `pipeline/ytshorts/cli.py:cmd_publish()` はアップロードとGASへの成功報告を同じtryで処理するため、成功報告の通信失敗も投稿失敗として扱う。再投稿前にYouTube側の実体を照合する必要がある（コード上のリスク、事故発生は未確認）。

### Codexの引き継ぎ確認(2026-09-10)
- 起点: `main` の `52a8f3b`。作業ブランチ: `codex/handoff-dashboard-bulk-actions`。Windowsの `C:\Users\tasuk\Documents\ChatGPT\PR戦略_SNS運営\Youtube_Short_movies` に新規clone。既存のUbuntu運用機とは別環境。
- 修正内容: 「承認待ちを全部却下」は `stock` のみ、「予約中を全部今すぐ投稿」は `approved` / `scheduled` のみを対象とする。個別操作・トークン認証・旧データのkind未設定対応を維持。
- 再現と検証: 修正前はGAS回帰テスト14件中3件が対象範囲の誤りで失敗、修正後は14件すべて成功。Python既存132件は変更前後とも成功。`git diff --check` も成功。
- 実行環境: Python 3.14.6 / Node.js 24.18.0。`pipeline/.venv` にテスト用のpytest/PyYAMLのみ導入（本番依存・GPU・動画レンダリング環境は未構築）。Ubuntu向け `make test` の代わりに、`pipeline` 内で `.venv/Scripts/python -m pytest tests/ -q` を実行。
- GASテスト: ルートで `node --test gas/tests/dashboard.test.cjs`。シート・Slack・Actionsはスタブのため外部送信なし。`.github/workflows/test.yml` にPython 3.12 / Node.js 24のpush/PR時テストを追加したが、未pushのためGitHub上では未実行。
- 運用確認: 読み取り時点の直近8件のGitHub Actionsはすべてsuccess。ただし最新HANDOFF追加前の `c009d6c` に対する実行で、実際に動画が投稿されたことやGAS本番コードとの一致を保証しない。
- 本番操作: push・マージ・GASデプロイ・設定変更・Slack通知・YouTube投稿は行っていない。既存のURLとシークレットは変更していない。

### Astra対応の実装と検証(2026-09-10)
- API: `gpt-6-astra` / Responses API、テキストと画像入力、既定の推論量はmedium。動画そのものは入力せず、faster-whisper文字起こしと元動画の3フレームを使う。公式仕様へのリンクは `ASTRA_SETUP.md`。
- 互換性: `auto` でOpenAIキーがあればAstra、なければ既存Claude。明示的に `openai` / `anthropic` に固定可能。呼び出しエラー時に別providerへ切り替えない。キーの実値、GASのURL、実シート、新しいシート定義、本番設定は変更していない。
- テーマ: `gas/src/AI.js` を共通入口にし、`Themes.js` で稼働中の候補からAstraがテーマと切り口を選定。本人メモ・撮影実績・直近使用日・自己分析を渡す。候補名/カテゴリ/件数を検証し、理由をLogに保存。テーマの週次学習、質問生成、再生分析も共通入口へ接続。
- 編集: `pipeline/ytshorts/llm.py` と `config.py` でAPI選択。`planner.py` が各ショートのtheme/target_viewer/viewer_promiseを生成し `plan.json` に保存。`cli.py` が元動画を渡し、`illustrations.py` / `review.py` も共通入口を使用。provider/model/reasoningが変わったらキャッシュを作り直し、挿絵はprompt変更も検出する。
- 登録経路: `.env.example`、`pipeline/config.example.yaml`、`gas/src/Config.js`、`WebApp.js` の許可済み設定配布、`setup/pull-env.py`、`setup/setup.py`、`.github/workflows/process-videos.yml` を更新。新規の本番依存なし。
- 検証: Python 152件・GAS 23件成功。追加テストは `pipeline/tests/test_llm.py`、`test_env_setup.py`、`gas/tests/ai.test.cjs`。API形式・画像入力・失敗時の挙動・テーマ選択・キャッシュ更新・キー設定配布の認証をスタブで検証。Python compileall、CLI --help、Workflow YAML構文、git diff --checkも成功。CIのGASテスト対象を全test.cjsへ拡張。GitHub上のCIは未実行。
- 資料: `README.md`、`gas/README.md`、`pipeline/README.md` を現行仕様に更新し、`ASTRA_SETUP.md` に登録・切替・接続確認・実機検証手順を集約。
- 作業ブランチには前回の一括操作修正 `5197a46` と引き継ぎ `0d3922f` も含む。push/マージ前にこの差分範囲を確認すること。

### 台本の品質改善とHow to Speakの適用(2026-09-10)
- 作業ブランチ: `codex/script-quality`。起点はAstra対応の `0bd747c`。前回のAstra対応と一括操作修正も含む。
- 基準: MIT公式講義ページとTranscriptを読み、冒頭の約束、具体例、一つの要点への回帰、自然な道標、視覚資料、締めの回収を短尺へ適用。原典のページと適用範囲、撮影ガイドの例は `SCRIPT_GUIDE.md`。例は説明用で、実API出力ではない。
- GAS: `ScriptQuality.js` を追加。質問・持ち帰り・導入・3段階の話す順・締め・追問・任意の視覚案を生成し、既存のhint列へ保存。`ShootScript.js` が直近30問と両方の学習方針を入力し、件数・テーマ・カテゴリ・必須項目・長さ・正規化後の重複を検証。構造不良は最大1回修復、繰り返し不良なら台本通知・質問保存を開始しない。APIエラーはここで再試行しない。テーマ選定のlast_used更新は従来どおり生成前に行われる。
- 編集: `planner.py` に撮影ガイドを渡すが、発話の証拠として扱わない。約束の回収と意味のある反復を残し、字幕・挿絵の装飾は必要な場合だけ。キャッシュは維持し、新規生成時に適用。既存動画には通常の再編集操作を使う。
- 検証: `node --test gas/tests/*.test.cjs` 33件、pipeline内の `.venv/Scripts/python -m pytest tests/ -q` 153件成功。`git diff --check` 成功。Slack・シート・APIはスタブ。実際の生成品質、意味上の重複、事実性、GAS実行時間内の完了、再生数の改善は未検証。新しい本番依存・シート列・シークレット変更なし。
- 反映状況: ユーザーは運用機で `git pull && make gas-deploy` 実施済みと報告。ただし確認時のGitHub mainは `52a8f3b8266388cd070641a00d639a573202abe9` のままで、本ローカルブランチの変更は含まれない。運用機のブランチ・コミット・GAS本番コードは未確認。改善コードをマージ/pushした後に、運用機で取り込みと既存デプロイの更新が必要。このWindows作業コピーではpush・マージ・デプロイ・Slack送信をしていない。

### マージ・pushの引き継ぎ(2026-09-11)
- ユーザーの「マージとプッシュして」により、`main` と `claude/youtube-short-auto-pipeline-d1z54a` の両方へ反映する。対象は `8cdc79c` までの一括操作修正・Astra対応・台本改善と本記録。下記の2026-09-10ログにある「未push」は当時の状態。
- fetch後、両リモートブランチが `52a8f3b` で、改善ブランチの祖先であることを確認。既存コミットを維持するfast-forwardで統合し、両参照をatomic pushする。完了は `git ls-remote origin refs/heads/main refs/heads/claude/youtube-short-auto-pipeline-d1z54a` とGitHub Actionsで確認する。
- マージ前の再検証: Python 153件・GAS 33件成功、`git diff --check origin/main HEAD` 成功。新しい機能変更は加えていない。
- GAS本番デプロイは別作業。push後、運用機で `cd ~/Youtube_Short_movies && git pull --ff-only && make gas-deploy` を実行する。以前のデプロイには今回の改善コードが含まれていない。実API品質・GAS応答時間・実素材の確認は引き続き必要。

### 採用目的への台本改良(2026-09-11)
- ユーザーはデプロイ後の台本を「当たり前で驚きがなく採用に繋がらない」と評価。実際の追加台本が乗車位置や空港の買い物順を中心にしていたことをSlackで確認。分かりやすさと撮影成立だけを目標にした前版を修正した。
- 作業時はユーザー指定に従い3エージェントが架空のレイ/セバスチャン/スキピオの視点で議論。その後「イーロンの広報担当」役の架空の広報責任者が批評し、発話例を作成。実在の広報担当者の見解や承認ではない。アプリ内は同一の選択モデルが3視点を演じる会議1回、批評1回、執筆1回の逐次API呼び出し。
- `EditorialRoom.js` を追加。会議が要求数+2案を出し、批評で新しい発見・具体性・仕事への関心を各4/5以上と判断した企画だけ執筆へ渡す。3視点・企画ID・全候補の採否・各テーマ・採用理由・修正案を検証し、前段失敗なら次段を呼ばない。点数はモデルの評価であり、採用効果の実測ではない。
- `Themes.js` はカテゴリ固定を撤廃し、台帳内の稼働中候補から最大2テーマ。1問指定時は1テーマだけ選ぶ。Claude選択時も共通AI選定に統一。既存テーマ名/category/weightと学習履歴は維持。新しい採用向けの切り口を企画として生成する。
- `ScriptQuality.js` / `ShootScript.js` は発話案・展開・回収を具体化し、固有の未確認箇所は本人確認として残す。hintに企画・対象・発見・仕事への接続・確認事項を保存。採用企画のID/テーマを照合。Logの `script_editorial` に短い会議講評・広報批評・採否と修正を残す。既存シート列や公開JSONの質問形式は変更なし。
- 新規の任意プロパティ: `SCRIPT_AUDIENCE`（既定は難しい開発に参加したい技術者）、`RECRUITING_CONTEXT`（公開可能な仕事/募集情報）。実値は変更していない。情報がない職種・待遇・裁量・応募URLは作らない。編集側の `planner.py` も発見・仕事の問いを維持し、未発話の台本を事実として使わない。
- 通常はテーマ選定込み4回、形式修復込み最大6回のAPI呼び出し。開始から240秒の時間予算、呼出前の残り30秒チェック、応答後の期限チェックを追加。ただし同期HTTP自体は中断できない。Slackの追加台本失敗には固定文の案内。長文はエスケープ後3500字以内で同じスレッドへ分割。
- 検証: Python 153件・GAS 66件成功、`git diff --check` 成功。段階順序/失敗停止/採否整合/品質閾値/締切/長文分割/1問設定/既存列互換をAPI・シート・Slackのスタブで確認。実APIの所要時間と費用、最終台本の面白さ、応募への効果は未測定。新規本番依存・秘密情報の変更なし。
- 資料: `SCRIPT_GUIDE.md` / `ASTRA_SETUP.md` / READMEを更新。`SCRIPT_EXAMPLES.md` の2案は会議・批評後のレビュー用発話案で、GAS実行結果や会社の実話ではない。
- 反映は前回に続きmainと既存作業ブランチへfast-forward/atomic pushし、両CIを確認する。GAS本番反映は運用機の `git pull --ff-only && make gas-deploy` が必要。この作業で実Slackへの投稿・API呼び出し・GASデプロイはしていない。

### 撮影カードへの反映(2026-09-11)
- ユーザー承認の `SCRIPT_CARD_DESIGN.md` を実装。問いの強度を下げず、前提・論拠・話の流れを用意する。レイ/セバスチャン/ハンニバルの会議→ミアの批評→執筆の3段階を維持。ハンニバルはスキピオに敗れ、敗因を内省して転生した架空の軍師で、外部投資家の視点も持つ。
- `EditorialRoom.js`: 共通前提・合理的な二つの仮説・弱点・判断変更条件を議論。ミアは発見/具体性/採用接続に加え、深さ/撮影負担/明瞭さを独立採点し全軸4/5以上を要求。点数は企画のモデル評価で、実際の面白さの保証ではない。
- `ScriptQuality.js`: writerはopening/premise/hypotheses（各statement/reason/weakness/reconsider）/closingと制作メモ項目を返す。仮想設定の明示、2仮説の各項目、読む本文最大650字を検証し、本人確認/TBD等の穴埋め・仮説の重複を拒否。前提の公平性や中立な結びは生成指示で点検するが、意味の正しさを機械検証で保証しない。
- 保存/APIは既存のtheme/category/question/neta/hintを維持。hintの `【撮影カード v2】` と `【制作メモ・読み上げない】` で分離し、旧自由記述はそのまま表示。新規カードは1問1メッセージ、全カードの後に各問の制作メモ。長いメモ/旧hintはエスケープ後3500文字以内に分割。シート列・データ移行・本番依存の追加なし。
- `ShootScript.js`: 読む引用部分、読まない案内、任意発言を説明。追加なしでも完成し、支持/反論/保留/別案を許す。Log版は `speaking-card-v2`、6軸の評価を記録。`planner.py` は仮想設定の明示と本人の反論等を残し、制作メモから未発話の内容を補わないよう指示。既存planキャッシュは維持。
- カード/メモを分離して投稿数が増えるため、このバッチ内は1秒以上間隔を空けて送る。他の実行との全体排他や429時の自動再送は未実装。送信途中の失敗は従来どおり一部配信済みになり得る。
- 検証: GAS 69件、Python 154件成功。保存往復後のカード/メモ分離、全仮説項目の読み上げ表示、穴埋め拒否、6軸品質判定、旧データ、文字数/メンション対策、前段失敗時の無配信をスタブで確認。本文の意味・実API生成品質・読み上げ時間・GAS応答時間・採用効果は未測定。
- mainと `claude/youtube-short-auto-pipeline-d1z54a` へ既存履歴を維持して統合し、両参照とCIを確認する。運用機では `cd ~/Youtube_Short_movies && git pull --ff-only && make gas-deploy`。この作業では実APIの生成、Slack送信、GASデプロイは行っていない。

### 引き継ぎログ
- 2026-09-10 Claude: 本引き継ぎ資料を作成。ここまでの実装は`git log`参照。
- 2026-09-10 Codex: ダッシュボードの一括却下/即時投稿を表示どおりの対象範囲に限定し、別タブの動画の誤操作を防止。回帰テスト14件、テストCI、実行手順を追加。コミット `5197a46`（ローカル、未push）。
- 2026-09-10 Codex: 引き継ぎの確認結果・検証コマンド・未デプロイ状態・投稿処理の持ち越しを本ファイルに記録。対応コミットは `git log -1 --format=oneline -- HANDOFF.md` で確認可能。
- 2026-09-10 Codex: ユーザーのAstra移行依頼に対応。OPENAI_API_KEYで撮影テーマ選定・素材の編集プラン・SVG挿絵・見た目評価・自己分析を実行可能にし、旧Claudeとの切替、キャッシュ、登録経路、疎通確認CLI、回帰テストと導入資料を整備。コミット `e37e7a2`（ローカル、未push）。
- 2026-09-10 Codex: Astra対応の検証結果・実機未確認事項・反映手順を本ファイルに追記。対応コミットは `git log -1 --format=oneline -- HANDOFF.md` で確認可能。
- 2026-09-10 Codex: 台本をHow to Speakに沿う構成ガイドへ拡張し、最近の質問との重複・構造を検証。撮影から編集へhintを渡し、仕様・例・実機未確認事項を記録。対応コミットは `git log -1 --format=oneline -- gas/src/ScriptQuality.js` で確認可能（ローカル、未push）。
- 2026-09-11 Codex: ユーザーの依頼に従いmainと既存作業ブランチへの統合対象・再検証結果・デプロイ手順を記録。対象コードは `5197a46` / `e37e7a2` / `8cdc79c`、本記録のコミットは `git log -1 --format=oneline -- HANDOFF.md` で確認可能。
- 2026-09-11 Codex: 台本を採用対象への発見と仕事の問いへ再設計。3者会議→架空の広報批評→発話案の生成・採否検証・長文分割・時間予算・失敗案内・例とテストを追加。対応コミットは `git log -1 --format=oneline -- gas/src/EditorialRoom.js` で確認可能。
- 2026-09-11 Codex: ユーザーは現行テーマの思考強度を高く評価し、下げたいのは準備・構成・読み分けの負担と明確化。最新の人格名はハンニバル（敗因を内省して転生した軍師）、批評役はミア。3者の議論とミアの批評を経て `SCRIPT_CARD_DESIGN.md` に、両仮説の完成文・任意の本人発言・どの立場からも戻れる締めと制作メモの分離を設計。生成コードへの適用は未実施。設計文書のみのためコードテストは再実行せず、読み上げ経路の確認と差分検査を実施。対応コミットは `git log -1 --format=oneline -- SCRIPT_CARD_DESIGN.md` で確認可能。

---
*質問があればユーザーに聞くより先に、コード・Logシート・このファイルを読むこと。それでも分からないことだけ聞く。健闘を祈る。 — Claude*
