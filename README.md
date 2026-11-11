# xpl

AI がコード差分を **少しずつ・図やアニメーション付きで** 解説してくれるローカル Web アプリ。
AI が大量に生成したコードを、人間が素早く・高い解像度で理解するためのツールです。

- **Codex app-server** 経由で、Codex CLI のログイン情報を使います
- 差分の種類: 作業ツリー（`git diff HEAD` + untracked）/ ブランチ比較（`base...head`）/ 特定コミット / GitHub PR（`gh pr diff`）
- AI はまず解説プラン（理解しやすい順に hunk をまとめたステップ）を作り、1 ステップずつ表示。**OK** で次へ
- 各ステップ: 解説 (Markdown) + 差分に応じて生成される図（Mermaid）やアニメーション（サンドボックス化した HTML/SVG）+ 該当 hunk
- 質問は「すぐに聞く」か「あとでまとめて」。まとめた質問は全ステップ終了後に AI が改めて回答
- AI は読み取り専用で動作。Codex の read-only サンドボックスでコードを調べます

## 必要なもの

- Node.js 18+
- Codex CLI にログイン済み: `npm install -g @openai/codex` のあと `codex login`（app-server の dynamic tools 対応版が必要。0.166.0 で動作確認）
- PR を使う場合は `gh` CLI（`gh auth login` 済み）

## 使い方

```sh
npm install
npm run build
npm start -- /path/to/your/repo   # http://localhost:4777
# または
./bin/xpl.mjs /path/to/your/repo  # ビルド→起動→ブラウザを開く
```

開発時は `npm run dev`（Vite :5173 + API :4777）。

Codex でプラン作成・ステップ解説・質問回答を行います。
モデル欄を空にすると Codex の既定モデルを使います。利用可能なモデル ID を直接指定することもできます。

### キーボード

- `Enter` / `→`: OK（次へ）　`←`: 前のステップ　`/`: 質問欄へ　`⌘/Ctrl+Enter`: 質問送信

### コードの折り返し

コードブロック右上の `wrap` / `nowrap` ボタンで、ブロックごとに折り返しを切り替えられます。初期表示は `wrap`（折り返しあり）で、`nowrap` では長い行を横スクロールできます。左右比較では両側が同時に切り替わります。

### ファイルの全文表示

コードブロック右上の「全文表示」でファイル全体を開き、「抜粋表示」で解説の範囲に戻せます。全文では他の hunk も含めて追加行を緑、削除行を赤で表示します。「変更後」の抜粋から開いた場合も、全文では削除行を含む差分になります。左右比較・削除前のコード・周辺コードは元の表示形式のまま全文に切り替わり、注釈や折り返し設定も保持します。

作業ツリーは解説開始時点、ブランチ・コミット・PR は選択した版の内容を表示します。周辺コードは解説で読み込んだ時点の内容です。

### 環境変数

| 変数 | 説明 |
|---|---|
| `PORT` | サーバーのポート（既定 4777） |
| `XPL_REPO` | 既定のリポジトリパス |
| `XPL_CODEX_MODEL` | Codex 用の既定モデル（未指定なら Codex の設定を使用） |
| `XPL_CODEX_PATH` | Codex CLI の実行ファイル（既定 `codex`） |
| `XPL_USE_API_KEY=1` | CLI に API キー環境変数を渡す（既定では `OPENAI_API_KEY` / `CODEX_API_KEY` を該当プロセスから除外） |

## 構成

- `server/git.ts` — 差分取得とパース（hunk に `F2H1` のような ID を付与）
- `server/session.ts` — セッション進行と解説ツール。Codex には dynamic tools として公開
- `server/tools.ts` — 解説ツールの定義と Zod による入力検証
- `server/codex.ts` — Codex app-server の stdio 接続、ターン処理とツール呼び出し。read-only / 承認なしで動作し、継承した MCP・プラグイン・Apps はこのスレッドで無効化
- `server/prompt.ts` — システムプロンプト
- `src/` — React UI（Mermaid 描画、sandboxed iframe での HTML アニメーション、差分ビュー）
