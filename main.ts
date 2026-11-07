/**
 * page=1 〜 page=N のスクリーンショットを順番に撮るスクリプト（TypeScript版）
 *
 * ■ 準備（最初の1回だけ）
 *     npm install
 *     npx playwright install chromium
 *
 * ■ 使い方
 *   1. 下の URL_TEMPLATE を実際のURLに置き換える。
 *      ページ番号の部分を {page} にしてください。
 *        例: https://example.com/list?id=123&page={page}
 *      （page=1 のまま貼っても、page=数字 の部分を自動で置換します）
 *   2. 実行:
 *        npm run dev
 *   3. ログインが必要なサイトなら、ブラウザが開いて止まるので
 *      ログインしてからターミナルで Enter を押してください。
 *      ログイン状態は browser_profile フォルダに保存され、次回もそのまま使えます。
 *
 *   途中で止まっても、もう一度実行すれば撮っていないページから再開します。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { PDFDocument } from "pdf-lib";
import { chromium, type Page } from "playwright";

// ======== 設定（ここだけ書き換えればOK） ========

const URL_TEMPLATE = "https://example.com/path?xxx=yyy&page={page}"; // ← ここを置き換える

const START_PAGE = 1;
const END_PAGE = 224;

const OUTPUT_DIR = "screenshots"; // 保存先フォルダ
const FULL_PAGE = true; // true: 縦に長いページ全体 / false: 見えている範囲だけ
const VIEWPORT = { width: 1280, height: 900 } as const;

const LOGIN_FIRST = true; // ログインが必要なら true（最初に一時停止してログインを待つ）
const HEADLESS = false; // true にするとブラウザ画面を出さずに実行（ログイン済みのときだけ推奨）

const WAIT_AFTER_LOAD = 1500; // ページ表示後に待つミリ秒（画像の読み込み待ち）
const DELAY_BETWEEN = 1000; // ページ間の間隔ミリ秒（サーバー負荷を抑えるため）
const RETRIES = 3; // 失敗時のリトライ回数

const MAKE_PDF = true; // true なら最後に全ページを1つのPDFにまとめる
const PDF_NAME = "all_pages.pdf";

const PROFILE_DIR = "browser_profile"; // ログイン情報の保存場所

// ================================================

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function buildUrl(pageNumber: number): string {
  if (URL_TEMPLATE.includes("{page}")) {
    return URL_TEMPLATE.split("{page}").join(String(pageNumber));
  }
  const re = /([?&])page=\d+/;
  if (re.test(URL_TEMPLATE)) {
    return URL_TEMPLATE.replace(re, `$1page=${pageNumber}`);
  }
  console.error("URL_TEMPLATE に {page} か page=数字 を含めてください。");
  process.exit(1);
}

function shotPath(pageNumber: number): string {
  const width = String(END_PAGE).length;
  return path.join(OUTPUT_DIR, `page_${String(pageNumber).padStart(width, "0")}.png`);
}

function waitEnter(message: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(message, () => {
      rl.close();
      resolve();
    }),
  );
}

// 遅延読み込みの画像を表示させるため、一番下までスクロールしてから戻る
async function autoScroll(pg: Page): Promise<void> {
  await pg.evaluate(async () => {
    const step = window.innerHeight;
    let last = -1;
    for (let i = 0; i < 200; i++) {
      window.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, 150));
      const y = window.scrollY;
      if (y === last) break;
      last = y;
    }
    window.scrollTo(0, 0);
  });
}

async function makePdf(): Promise<void> {
  const files: string[] = [];
  for (let n = START_PAGE; n <= END_PAGE; n++) {
    const f = shotPath(n);
    if (fs.existsSync(f)) files.push(f);
  }
  if (files.length === 0) return;

  console.log(`\nPDFを作成中（${files.length}ページ）…`);
  const pdf = await PDFDocument.create();
  for (const f of files) {
    const img = await pdf.embedPng(fs.readFileSync(f));
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  fs.writeFileSync(PDF_NAME, await pdf.save());
  console.log(`PDFを保存しました → ${PDF_NAME}`);
}

async function main(): Promise<void> {
  if (URL_TEMPLATE.includes("example.com")) {
    console.error("URL_TEMPLATE を実際のURLに置き換えてください。");
    process.exit(1);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const failed: number[] = [];

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { ...VIEWPORT },
  });
  const pg = ctx.pages()[0] ?? (await ctx.newPage());

  if (LOGIN_FIRST && !HEADLESS) {
    await pg.goto(buildUrl(START_PAGE));
    await waitEnter("ブラウザでログインなどを済ませたら、ここで Enter を押してください… ");
  }

  for (let n = START_PAGE; n <= END_PAGE; n++) {
    const out = shotPath(n);
    if (fs.existsSync(out)) {
      console.log(`[skip] ${n}（撮影済み）`);
      continue;
    }

    let ok = false;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        await pg.goto(buildUrl(n), { waitUntil: "networkidle", timeout: 60000 });
        await sleep(WAIT_AFTER_LOAD);
        if (FULL_PAGE) {
          await autoScroll(pg);
          await sleep(500);
        }
        await pg.screenshot({ path: out, fullPage: FULL_PAGE });
        console.log(`[ok]   ${n}/${END_PAGE} → ${out}`);
        ok = true;
        break;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.log(`[retry ${attempt}/${RETRIES}] page ${n}: ${message}`);
        await sleep(3000);
      }
    }
    if (!ok) {
      failed.push(n);
      console.log(`[fail] ${n}`);
    }

    await sleep(DELAY_BETWEEN);
  }

  await ctx.close();

  if (failed.length) {
    console.log("\n失敗したページ:", failed.join(", "));
    console.log("もう一度実行すると、失敗したページだけ撮り直します。");
  } else if (MAKE_PDF) {
    await makePdf();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
