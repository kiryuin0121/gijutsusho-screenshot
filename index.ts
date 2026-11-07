/**
 * ページ送り形式のWebページ（page=1 … page=N）を順番にスクリーンショットし、
 * 最後に1つのPDFにまとめるスクリプト（Bun + Playwright）。
 *
 * ■ 準備（最初の1回だけ）
 *     bun install
 *     bun run setup          # Chromium のダウンロード
 *
 * ■ 使い方
 *     1. 下の CONFIG を書き換える（URL のページ番号部分を {page} にする）
 *     2. bun start
 *     3. ログインが必要なサイトなら、ブラウザが開いて止まるので
 *        ログインしてからターミナルで Enter を押す
 *
 * ログイン状態は browser_profile/ に保存され、次回もそのまま使えます。
 * 撮影済みの画像はスキップするので、途中で止めても再実行すれば続きから再開します。
 */

import { chromium, type Page } from "playwright";
import { PDFDocument } from "pdf-lib";

// ======== 設定（ここだけ書き換えればOK） ========

const CONFIG = {
  /** ページ番号部分を {page} にしたURL。例: "https://example.com/list?id=123&page={page}" */
  url: "https://example.com/path?xxx=yyy&page={page}",

  fromPage: 1,
  toPage: 224,

  /** 画像の保存先フォルダ */
  outDir: "screenshots",
  /** まとめたPDFの出力先。null ならPDFを作らない */
  pdfPath: "all_pages.pdf" as string | null,

  /** true: 縦に長いページ全体 / false: 見えている範囲だけ */
  fullPage: true,
  viewport: { width: 1280, height: 900 },

  /** 起動時にログイン待ちで一時停止する */
  waitForLogin: true,
  /** true にするとブラウザ画面を出さずに実行（ログイン済みのときだけ推奨） */
  headless: false,
  /** ログイン情報の保存先 */
  profileDir: "browser_profile",

  /** ページ表示後に待つミリ秒（画像の読み込み待ち） */
  settleMs: 1500,
  /** ページ間の間隔ミリ秒（サーバー負荷を抑えるため） */
  intervalMs: 1000,
  /** 失敗時のリトライ回数 */
  retries: 3,
  /** ページ遷移のタイムアウトミリ秒 */
  timeoutMs: 60_000,
};

// ================================================

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ページ番号を埋め込んだURL */
function pageUrl(n: number): string {
  return CONFIG.url.replaceAll("{page}", String(n));
}

/** 0埋めした連番ファイル名。桁数を揃えるので並び順＝ページ順になる */
function shotPath(n: number): string {
  const digits = String(CONFIG.toPage).length;
  return `${CONFIG.outDir}/page_${String(n).padStart(digits, "0")}.png`;
}

/** 遅延読み込みの画像を表示させるため、一番下までスクロールしてから戻る */
async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(async () => {
    let previous = -1;
    for (let i = 0; i < 200; i++) {
      window.scrollBy(0, window.innerHeight);
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (window.scrollY === previous) break;
      previous = window.scrollY;
    }
    window.scrollTo(0, 0);
  });
}

// ---- 設定チェック ----

if (CONFIG.url.includes("example.com")) {
  console.error("index.ts の CONFIG.url を実際のURLに置き換えてください。");
  process.exit(1);
}
if (!CONFIG.url.includes("{page}")) {
  console.error("CONFIG.url にページ番号の位置を示す {page} を含めてください。");
  process.exit(1);
}

// ---- ブラウザ起動（ログイン状態を使い回すため永続プロファイル） ----

const context = await chromium.launchPersistentContext(CONFIG.profileDir, {
  headless: CONFIG.headless,
  viewport: CONFIG.viewport,
});
const page = context.pages()[0] ?? (await context.newPage());

if (CONFIG.waitForLogin && !CONFIG.headless) {
  await page.goto(pageUrl(CONFIG.fromPage), { timeout: CONFIG.timeoutMs }).catch(() => {});
  process.stdout.write("ブラウザでログインなどを済ませたら Enter を押してください… ");
  for await (const _ of console) break; // Bun: 標準入力を1行待つ
}

// ---- 撮影ループ ----

const total = CONFIG.toPage - CONFIG.fromPage + 1;
const captured: string[] = [];
const failed: number[] = [];

console.log(`ページ ${CONFIG.fromPage}〜${CONFIG.toPage} を撮影します → ${CONFIG.outDir}/`);

for (let n = CONFIG.fromPage; n <= CONFIG.toPage; n++) {
  const file = shotPath(n);
  const progress = `[${String(n - CONFIG.fromPage + 1).padStart(String(total).length)}/${total}]`;

  // 撮影済みなら飛ばす（中断後の再開用）
  if (await Bun.file(file).exists()) {
    captured.push(file);
    console.log(`${progress} skip  p${n}（撮影済み）`);
    continue;
  }

  let done = false;
  for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
    try {
      await page.goto(pageUrl(n), { waitUntil: "networkidle", timeout: CONFIG.timeoutMs });
      await sleep(CONFIG.settleMs);
      if (CONFIG.fullPage) {
        await scrollToBottom(page);
        await sleep(500);
      }
      await page.screenshot({ path: file, fullPage: CONFIG.fullPage });
      captured.push(file);
      console.log(`${progress} ok    p${n} → ${file}${attempt > 1 ? `（${attempt}回目で成功）` : ""}`);
      done = true;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`${progress} retry ${attempt}/${CONFIG.retries} p${n}: ${message}`);
      if (attempt < CONFIG.retries) await sleep(Math.min(2 ** attempt * 1000, 10_000));
    }
  }
  if (!done) {
    failed.push(n);
    console.log(`${progress} fail  p${n}`);
  }

  if (CONFIG.intervalMs > 0 && n < CONFIG.toPage) await sleep(CONFIG.intervalMs);
}

await context.close();

// ---- 結果とPDF作成 ----

console.log(`\n完了 ${captured.length} / 失敗 ${failed.length}`);

if (failed.length > 0) {
  console.log(`失敗したページ: ${failed.join(", ")}`);
  console.log("もう一度実行すると、失敗したページだけ撮り直します。");
  process.exit(1);
}

if (CONFIG.pdfPath !== null && captured.length > 0) {
  console.log(`PDFを作成中（${captured.length}ページ）…`);
  const pdf = await PDFDocument.create();
  for (const file of captured) {
    const image = await pdf.embedPng(await Bun.file(file).bytes());
    const pdfPage = pdf.addPage([image.width, image.height]);
    pdfPage.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  await Bun.write(CONFIG.pdfPath, await pdf.save());
  console.log(`PDFを保存しました → ${CONFIG.pdfPath}`);
}
