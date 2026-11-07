# gijutsusho-screenshot

ページ送り形式のWebページ（page=1〜N）を順番にスクリーンショットして、1つのPDFにまとめる TypeScript スクリプト。

## セットアップ

```bash
npm install
npx playwright install chromium
```

## 設定

`main.ts` 上部の設定を書き換えます。

- `URL_TEMPLATE` … ページ番号部分を `{page}` にしたURL（例: `https://example.com/list?id=123&page={page}`）
- `START_PAGE` / `END_PAGE` … 撮影するページ範囲
- `LOGIN_FIRST` … ログインが必要なサイトなら `true`（起動後に一時停止してログインを待つ）

## 実行

```bash
npm run dev
```

ログイン状態は `browser_profile/` に保存され、次回以降も再利用されます。
途中で中断しても、再実行すれば未撮影のページから再開します。

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | TypeScript のまま実行（tsx） |
| `npm run build` | `dist/` へコンパイル |
| `npm start` | ビルド済みJSを実行 |
| `npm run typecheck` | 型チェックのみ |
