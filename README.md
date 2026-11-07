# gijutsusho-screenshot

ページ送り形式のWebページを連番で取得し、1つのPDFにまとめるスクリプト。

## セットアップ

```bash
bun install
bun run setup   # Chromium のダウンロード
```

## 使い方

`index.ts` 冒頭の `CONFIG` を書き換えて実行する。

```bash
bun start
```

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `bun start` | 実行 |
| `bun run setup` | Chromium のインストール |
| `bun run typecheck` | 型検査 |
