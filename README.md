# xpl

AI がコード差分を **少しずつ・図やアニメーション付きで** 解説してくれるローカル Web アプリ。
AI が大量に生成したコードを、人間が素早く・高い解像度で理解するためのツールです。

- Claude Agent SDK 経由で、**あなたの Claude サブスクリプション**（`claude` CLI のログイン）を使います
- 差分の種類: 作業ツリー（`git diff HEAD` + untracked）/ ブランチ比較（`base...head`）/ 特定コミット / GitHub PR（`gh pr diff`）
- AI はまず解説プラン（理解しやすい順に hunk をまとめたステップ）を作り、1 ステップずつ表示。**OK** で次へ
- 各ステップ: 解説 (Markdown) + 差分に応じて生成される図（Mermaid）やアニメーション（サンドボックス化した HTML/SVG）+ 該当 hunk
- 質問は「すぐに聞く」か「あとでまとめて」。まとめた質問は全ステップ終了後に AI が改めて回答
- AI は読み取り専用ツール（Read / Grep / Glob）のみ使用。ファイルは変更しません

## 必要なもの

- Node.js 18+
- Claude Code にログイン済み（`claude` を起動して `/login`）
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

### キーボード

- `Enter` / `→`: OK（次へ）　`←`: 前のステップ　`/`: 質問欄へ　`⌘/Ctrl+Enter`: 質問送信

### 環境変数

| 変数 | 説明 |
|---|---|
| `PORT` | サーバーのポート（既定 4777） |
| `XPL_REPO` | 既定のリポジトリパス |
| `XPL_MODEL` | 既定モデル（`opus` / `sonnet` / `haiku` など） |
| `XPL_USE_API_KEY=1` | `ANTHROPIC_API_KEY` を使う（既定ではサブスクリプション利用のため除外） |

## 構成

- `server/git.ts` — 差分取得とパース（hunk に `F2H1` のような ID を付与）
- `server/session.ts` — Agent SDK セッション。カスタム MCP ツール `submit_plan` / `present_step` / `answer_question` / `get_diff` で AI が GUI に出力
- `server/prompt.ts` — システムプロンプト
- `src/` — React UI（Mermaid 描画、sandboxed iframe での HTML アニメーション、差分ビュー）
