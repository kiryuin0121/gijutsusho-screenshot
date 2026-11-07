# gijutsusho-screenshot

ページ送り形式のWebページを連番で取得し、1つのPDFにまとめるスクリプト。

## セットアップ

```bash
bun install
bun run setup        # Chromium のダウンロード
cp .env.example .env # VIEWER_URL を書く
```

## 使い方

`.env` に対象URLを設定し（ページ番号部分を `{page}` にする）、実行する。
その他の設定は `index.ts` 冒頭の `CONFIG`。

```bash
bun start
```

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `bun start` | 実行 |
| `bun run setup` | Chromium のインストール |
| `bun run typecheck` | 型検査 |
