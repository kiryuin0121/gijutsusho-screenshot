# gijutsusho-screenshot

ページ送り形式のWebページ（`page=1` … `page=N`）を連番でスクリーンショットし、1つのPDFにまとめるスクリプト。

- **Bun + Playwright** — ビルド不要、`index.ts` を直接実行
- **中断しても安全** — 撮影済みの画像はスキップするので、再実行すれば続きから再開
- **ログイン対応** — 永続プロファイルにログイン状態を保存し、次回以降は再ログイン不要

## セットアップ

```bash
bun install
bun run setup   # Chromium のダウンロード
```

## 使い方

1. `index.ts` 冒頭の `CONFIG` を書き換える（URL のページ番号部分を `{page}` にする）

   ```ts
   url: "https://example.com/list?id=123&page={page}",
   toPage: 224,
   ```

2. 実行

   ```bash
   bun start
   ```

3. ログインが必要なサイトなら、ブラウザが開いて止まるのでログインしてから
   ターミナルで Enter を押す（2回目以降は `CONFIG.headless = true` で画面なし実行も可）

画像は `screenshots/` に、PDFは `all_pages.pdf` に出力されます。

## 設定項目（`index.ts` の `CONFIG`）

| キー | 既定値 | 内容 |
| --- | --- | --- |
| `url` | — | `{page}` を含むURL |
| `fromPage` / `toPage` | `1` / `224` | 撮影するページ範囲 |
| `outDir` | `screenshots` | 画像の保存先 |
| `pdfPath` | `all_pages.pdf` | PDFの出力先（`null` でPDFを作らない） |
| `fullPage` | `true` | ページ全体を撮る / 表示範囲のみ |
| `viewport` | `1280x900` | ウィンドウサイズ |
| `waitForLogin` | `true` | 起動時にログイン待ちで一時停止 |
| `headless` | `false` | ブラウザ画面を出さずに実行 |
| `profileDir` | `browser_profile` | ログイン情報の保存先 |
| `settleMs` | `1500` | 表示後の待機（画像読み込み待ち） |
| `intervalMs` | `1000` | ページ間の待機（サーバー負荷対策） |
| `retries` | `3` | リトライ回数（指数バックオフ） |
| `timeoutMs` | `60000` | ページ遷移のタイムアウト |

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `bun start` | 実行 |
| `bun run setup` | Chromium のインストール |
| `bun run typecheck` | 型検査（`tsc --noEmit`） |

> **注意:** `typescript` は 5.9 系に固定しています。プレビュー版の 7.0.x では
> `node:` 系モジュールの解決に失敗して `TS2591` が大量に出ます。
> VS Code もワークスペースのバージョンを使うよう `.vscode/settings.json` で指定済みです。
