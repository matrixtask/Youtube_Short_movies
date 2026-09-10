# Astraによるテーマ選定・動画編集

APIモデルは `gpt-6-astra`、キーの名前は `OPENAI_API_KEY`。
テーマ選定・質問生成・編集プラン・SVG挿絵・見た目採点・再生実績の自己分析を
OpenAI Responses APIに接続します。既存のClaude設定も引き続き使用できます。

## キーの登録場所

| 実行場所 | キーを登録する場所 | 必須の名前 | 担当 |
|---|---|---|---|
| GAS | プロジェクトの設定 → スクリプトプロパティ | `OPENAI_API_KEY` | テーマ・台本・自己分析 |
| GitHub Actions | Settings → Secrets and variables → Actions → Repository secrets | `OPENAI_API_KEY` | 動画のテーマ・編集・採点 |
| ローカルPC（使う場合） | リポジトリルートの管理外 `.env` | `OPENAI_API_KEY` | 同じ編集パイプライン |

値は上記に登録し、ソースコードやチャットに記載しません。
1か所への登録は他の実行場所へ自動同期されません。`.env.example` は雛形です。
`make` は `.env` を読み込みますが、`python -m ytshorts` を直接使う場合は
環境変数を別途設定してください。`make env-pull` でGASからローカルへ配布する場合は、
既存の `ALLOW_ENV_EXPORT=true` による一時許可と、使用後の解除が必要です。

既存環境の切り替えにはセットアップウィザードの再実行は不要です。
ウィザードにはADMIN_TOKEN再生成やGAS初期設定も含まれるため、既存プロパティと
GitHub Secretの追加だけを行ってください。

## 選択ルール

| 用途 | GASプロパティ | ローカル環境変数 / GitHub ActionsのRepository variable | 既定 |
|---|---|---|---|
| API選択 | `LLM_PROVIDER` | `YTSHORTS_LLM_PROVIDER` | `auto` |
| OpenAIモデル | `OPENAI_MODEL` | `YTSHORTS_OPENAI_MODEL` | `gpt-6-astra` |
| 推論量 | `OPENAI_REASONING_EFFORT` | `YTSHORTS_OPENAI_REASONING_EFFORT` | `medium` |

- `auto`: OpenAIキーが登録済みならAstra、なければ既存のClaudeを使用。
- `openai`: Astraに固定。OpenAIキーがなければ明示的に失敗。
- `anthropic`: 既存のClaudeに固定。

キーだけを登録すれば `auto` でAstraが選ばれます。旧プロバイダーに固定する設定が
残っていないことも確認してください。AstraのAPI失敗時にClaudeへ自動変更はしません。
GASとActionsの片方だけキーを設定すると、テーマと編集で異なるAIが動きます。

## 処理内容

撮影台本はMITのPatrick Winston「How to Speak」を短尺に応用した
[台本生成基準](SCRIPT_GUIDE.md)に従います。質問に加え、冒頭の約束・話す順・締め・追問を
既存のhint列へ保存し、Slackと編集処理へ渡します。直近30問を参照し、3者の企画会議、
架空の広報責任者の批評を経て発話案を生成。執筆の構造不良は1回だけ再生成します。
`SCRIPT_AUDIENCE` / `RECRUITING_CONTEXT` は任意のGASプロパティです。未設定でも既定の技術者向けに動きます。
機械検証は構造と正規化後の重複を対象とし、事実性や話の面白さまで保証するものではありません。

1. **撮影テーマ**: カテゴリを固定せず稼働中候補から最大2テーマを選び、本人のメモ、
   撮影実績、最終使用日、過去の自己分析に沿った切り口を作ります。休止中
   （weight 0）のテーマは候補に送りません。テーマ名を維持し、理由をLogの
   `theme_ai_selection` に記録します。存在しない候補・重複は拒否し、カテゴリは元の台帳から引き継ぎます。
   会議・批評・採否の短い記録は `script_editorial`。会議はモデルが演じる3つの架空の視点で、実在者の見解ではありません。
2. **素材ごとの編集**: 文字起こしと、元動画の10%・50%・90%地点の参考フレームを入力。
   `theme`、`target_viewer`、`viewer_promise` を各ショートに設定し、タイトル・フック・
   切り出し・字幕・挿絵へ反映するよう指示します。時刻は文字起こしを根拠にします。
   抽出に失敗したフレームは省略し、文字起こしで処理します。
3. **実際の編集**: 既存のfaster-whisperとffmpegを使用。Astraは編集プランとSVG挿絵を生成。
   生成済みの動画フレームをAstraが採点し、既存の最大2回の修正ループを使用します。
4. **記録**: セッションの `plan.json` にテーマ等と `_ai`（provider/model/reasoning）を保存。
   モデルや推論量の変更時はプランと挿絵を再生成します。同じ設定ならキャッシュを再利用。
   従来Claudeの識別情報がないキャッシュは、Claude運用時に限り維持します。

素材にない事実・数字・体験を創作しない指示を追加していますが、内容の正確さや
テーマの適合度は実素材で確認が必要です。ニュース検索は追加していません。
生成済み・投稿済みの動画を、キー登録だけで一括再編集することはありません。
再編集の入口は既存のSlack/ダッシュボードの再編集操作です。

## 接続確認と運用への反映

コード反映後、キーを環境変数に設定したローカル環境で:

```bash
cd pipeline
.venv/bin/python -m ytshorts ai-check
```

Windowsでは `pipeline` 内で `.venv/Scripts/python -m ytshorts ai-check`。
`AI: openai / gpt-6-astra` と接続OKが出ることを確認します。このコマンドは短いAPI呼び出しを
行うためAPI料金が発生しますが、動画のclaim・Slack送信・YouTube投稿は行いません。

GitHub Actionsはコードのマージ/push後に反映されます。GASは既存のデプロイIDに
`make gas-deploy` で更新が必要です。新しいデプロイを作らず、URLを維持します。
GASのテーマ選定と編集の実機検証には、接続済み環境で台本1回・動画1本の処理を使います。
YouTube公開は既存の承認フローに従います。

## テストと制約

APIキーなしで、次のテストを実行できます。

```bash
# リポジトリルート
node --test gas/tests/*.test.cjs
# pipeline内（pytest/PyYAMLを導入したPython）
python -m pytest tests/ -q
```

追加の本番Python/npm依存はありません。Python APIクライアントは標準ライブラリ、
GASはUrlFetchAppを使用します。Responsesの出力上限には推論分を含め、1回あたり
`max(12000, 呼出元の出力上限 + 8000)` トークンです。Pythonは429/一部5xxを最大3試行、
JSONパースは最大2試行。GASは実行時間制限を考慮してHTTPの再試行をしません。
不完全応答・拒否・空応答は採用しません。HTTPエラー本文はログに保存しません。
`store: false` を指定しています。

見た目評価や挿絵が失敗したときに、採点・挿絵なしで続行する既存の仕様は維持しています。
台本はテーマ選定を含め通常4回、JSON/構造の修復を含め最大6回の呼び出しです。
開始から240秒の時間予算を置き、次のモデル呼び出し前に30秒以上残っていなければ停止します。
各モデル応答後も期限を確認しますが、進行中のHTTP通信を中断する仕組みではありません。
GASの制限時間、Astraの応答時間・利用額、画像を含む実素材の編集品質は実運用で確認してください。

公式仕様（2026-09-10確認）:
[Astraのモデル仕様](https://developers.openai.com/api/docs/models/gpt-6-astra)、
[画像入力](https://developers.openai.com/api/docs/guides/images-vision)、
[Astraの移行ガイド](https://developers.openai.com/api/docs/guides/latest-model)。
Astraはテキスト・画像入力に対応し、動画・音声の直接入力には対応していません。
