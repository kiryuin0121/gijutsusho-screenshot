/**
 * 見開き型のページビューアから全ページを取得し、
 * 1つのPDFにまとめるスクリプト（Bun + Playwright）。対象URLは .env の VIEWER_URL。
 *
 * ■ 仕組み
 * 対象のビューアは各ページを JPEG の data URI として <img> に埋め込んでいる。
 * なので画面を撮影するのではなく、その data URI をそのまま保存する。
 * 見た目ではなく元画像（875x1241）が手に入るので、速いうえに画質も落ちない。
 *
 * 1スライド = 見開き2ページぶんで、中に左右2枚の <img> を持つ。
 * URLの page は2刻み（奇数を指定しても偶数に丸められる）ので、
 * スライド単位で巡回して左右2枚とも回収する。
 *     ページ番号 = スライド番号 * 2 + (左:0 / 右:1)   ← 紙面のノンブルと一致する
 *
 * 見開きの配置合わせのため、画像を持たない空きスライドが混ざることがある。
 * そのぶんのページ番号は欠番として扱う（失敗ではない）。
 *
 * ■ 準備（最初の1回だけ）
 *     bun install
 *     bun run setup          # Chromium のダウンロード
 *     cp .env.example .env   # VIEWER_URL を書く
 *
 * ■ 使い方
 *     1. .env の VIEWER_URL を設定する（ページ番号部分を {page} にする）
 *     2. bun start
 *     3. 未ログインなら headless: false / waitForLogin: true で実行すると
 *        ブラウザが開いて止まるので、ログインしてから Enter を押す
 *
 * ログイン状態は browser_profile/ に保存され、次回もそのまま使えます。
 * 取得済みの画像はスキップするので、途中で止めても再実行すれば続きから再開します。
 * PDFを作り終えたら画像は削除されます（keepImages: true で残せます）。
 */

import { Buffer } from "node:buffer";
import { unlink } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { PDFDocument } from "pdf-lib";

// ======== 設定（ここだけ書き換えればOK） ========

const CONFIG = {
  /** ページ番号部分を {page} にしたURL。.env の VIEWER_URL に書く */
  url: process.env.VIEWER_URL ?? "",

  /** 取得する最初のページ番号。ページ1が先頭（ページ0は存在しない） */
  fromPage: 1,
  /** 最後のページ番号。null ならビューアに載っている分を自動で調べる */
  toPage: null as number | null,

  /** 画像の一時保存先フォルダ */
  outDir: "screenshots",

  /** PDFを作るか */
  createPdf: true,
  /** PDFの出力先フォルダ */
  pdfDir: "output",
  /** PDFのファイル名。null ならURLと日時から自動命名する（上書き防止） */
  pdfPath: null as string | null,
  /** 自動命名のとき、ファイル名に使うURLクエリのパラメータ名 */
  pdfNameParam: "pdf",
  /** PDFを作ったあとも画像を残すか */
  keepImages: false,

  /** 同時に開くタブの数。増やすほど速いがメモリとサーバー負荷も増える */
  concurrency: 3,

  /** true にするとブラウザ画面を出さずに実行。未ログインだと取得できない */
  headless: true,
  /** 起動時にログイン待ちで一時停止する（headless: false のときだけ有効） */
  waitForLogin: false,
  /** ログイン情報の保存先 */
  profileDir: "browser_profile",
  viewport: { width: 1280, height: 900 },

  /** 1枚目の画像を待つ上限ミリ秒。ここを過ぎたら空きスライドの可能性が高い */
  firstImageMs: 8_000,
  /** 1枚目のあと、2枚目を待つ上限ミリ秒 */
  secondImageMs: 8_000,
  /** ページ間の間隔ミリ秒（サーバー負荷を抑えるため） */
  intervalMs: 0,
  /** 取りこぼしを拾い直す回数 */
  retries: 3,
  /** ページ遷移のタイムアウトミリ秒 */
  timeoutMs: 60_000,
};

// ================================================

/** ページ画像を収めているスライド要素 */
const VIEW_PAGE = "div[class*=view_page]";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ページ番号を埋め込んだURL */
function pageUrl(n: number): string {
  return CONFIG.url.replaceAll("{page}", String(n));
}

let digits = 3; // 総ページ数が分かった時点で確定する
/** 0埋めした連番ファイル名。桁数を揃えるので並び順＝ページ順になる */
function shotPath(n: number): string {
  return `${CONFIG.outDir}/page_${String(n).padStart(digits, "0")}.jpg`;
}

/** URLから出力先を決める。同名があれば連番を足すので、既存のPDFは上書きしない */
async function autoPdfPath(): Promise<string> {
  let slug = "pages";
  try {
    slug = new URL(pageUrl(CONFIG.fromPage)).searchParams.get(CONFIG.pdfNameParam) ?? slug;
  } catch {
    // URLとして解釈できない形でも止めない
  }
  const base = `${CONFIG.pdfDir}/${slug.replace(/[^\w.-]/g, "_")}`;

  let path = `${base}.pdf`;
  for (let i = 2; await Bun.file(path).exists(); i++) path = `${base}_${i}.pdf`;
  return path;
}

async function openSlide(page: Page, slide: number): Promise<void> {
  // 先頭スライドは page=0 では画像が読み込まれない。page=1 で開く必要がある
  const n = slide === 0 ? 1 : slide * 2;
  await page.goto(pageUrl(n), { waitUntil: "load", timeout: CONFIG.timeoutMs });
}

/** 指定スライドに読み込み済みのページ画像が何枚あるか */
function countImages(page: Page, slide: number): Promise<number> {
  return page.evaluate(
    ({ slide, sel }) =>
      [
        ...(document.querySelector(`${sel}[data-slick-index="${slide}"]`)?.querySelectorAll("img") ?? []),
      ].filter((img) => img.src.startsWith("data:image") && img.naturalWidth > 500).length,
    { slide, sel: VIEW_PAGE },
  );
}

/**
 * スライドの画像がそろうのを待つ。
 * 1枚目が来ない空きスライドでは待ち続けず、早めに切り上げる。
 * 先頭スライドは元から1枚なので、2枚目を待たない。
 */
async function waitSlide(page: Page, slide: number): Promise<void> {
  const reach = (want: number, timeout: number) =>
    page.waitForFunction(
      ({ slide, want, sel }) =>
        [
          ...(document.querySelector(`${sel}[data-slick-index="${slide}"]`)?.querySelectorAll("img") ?? []),
        ].filter((img) => img.src.startsWith("data:image") && img.naturalWidth > 500).length >= want,
      { slide, want, sel: VIEW_PAGE },
      { timeout },
    );

  try {
    await reach(1, CONFIG.firstImageMs);
  } catch {
    return; // 空きスライドか読み込み失敗。2枚目を待つ意味はない
  }
  if (slide === 0) return; // 右ページだけの半端な見開き
  await reach(2, CONFIG.secondImageMs).catch(() => {}); // 最終スライドは1枚で終わる
}

/**
 * いま読み込まれているスライドから、ページ画像の data URI を全部集める。
 * 1回の遷移で前後のスライドも読み込まれるので、ついでに回収して遷移回数を減らす。
 */
function harvest(page: Page, lastSlide: number): Promise<[number, string][]> {
  return page.evaluate(
    ({ lastSlide, sel }) =>
      [...document.querySelectorAll(sel)].flatMap((el) => {
        const slide = Number(el.getAttribute("data-slick-index"));
        if (!Number.isFinite(slide)) return [];
        const imgs = [...el.querySelectorAll("img")].filter(
          (img) => img.src.startsWith("data:image") && img.naturalWidth > 500,
        );
        // 左右そろっていないと左右どちらか判別できずページ番号を取り違えるので見送る。
        // 先頭と最後のスライドだけは元から1枚で終わるので通す。
        if (imgs.length < 2 && slide !== 0 && slide !== lastSlide) return [];
        // 先頭スライドは右ページだけの半端な見開きで、1枚ならページ1にあたる
        const pages =
          slide === 0 && imgs.length < 2 ? [1] : imgs.map((_, i) => slide * 2 + i);
        return imgs.map((img, i) => [pages[i]!, img.src] as [number, string]);
      }),
    { lastSlide, sel: VIEW_PAGE },
  );
}

// ---- 設定チェック ----

if (!CONFIG.url) {
  console.error(".env に VIEWER_URL を設定してください（.env.example を参照）。");
  process.exit(1);
}
if (!CONFIG.url.includes("{page}")) {
  console.error("VIEWER_URL にページ番号の位置を示す {page} を含めてください。");
  process.exit(1);
}

// ---- ブラウザ起動（ログイン状態を使い回すため永続プロファイル） ----

const started = Date.now();
const context = await chromium.launchPersistentContext(CONFIG.profileDir, {
  headless: CONFIG.headless,
  viewport: CONFIG.viewport,
});
const probe = context.pages()[0] ?? (await context.newPage());

if (CONFIG.waitForLogin && !CONFIG.headless) {
  await probe.goto(pageUrl(CONFIG.fromPage), { timeout: CONFIG.timeoutMs }).catch(() => {});
  process.stdout.write("ブラウザでログインなどを済ませたら Enter を押してください… ");
  for await (const _ of console) break; // Bun: 標準入力を1行待つ
}

// ---- スライド数と総ページ数を調べる ----

await probe.goto(pageUrl(CONFIG.fromPage), { waitUntil: "load", timeout: CONFIG.timeoutMs });
const slideCount = await probe.evaluate((sel) => document.querySelectorAll(sel).length, VIEW_PAGE);
if (slideCount === 0) {
  console.error("ページ画像が見つかりません。ログインが切れているか、URLが違う可能性があります。");
  await context.close();
  process.exit(1);
}

const lastSlide = slideCount - 1;
let toPage = CONFIG.toPage ?? -1;
if (toPage < 0) {
  // 最後のスライドは1ページだけのことがあるので、実際に開いて枚数を数える
  await openSlide(probe, lastSlide);
  await waitSlide(probe, lastSlide);
  toPage = lastSlide * 2 + Math.max(await countImages(probe, lastSlide), 1) - 1;
}
digits = String(toPage).length;

console.log(`全 ${slideCount} スライド / ページ ${CONFIG.fromPage}〜${toPage}`);

// ---- 取得 ----

const images = new Map<number, string>(); // ページ番号 → ファイル
const slidesWithImages = new Set<number>(); // 1枚でも画像を見たスライド
const emptyVisits = new Map<number, number>(); // スライド → 空振りした回数

const wanted = (n: number) => n >= CONFIG.fromPage && n <= toPage;

// 前回の途中まで取れている分を引き継ぐ
for (let n = CONFIG.fromPage; n <= toPage; n++) {
  const file = shotPath(n);
  if (await Bun.file(file).exists()) {
    images.set(n, file);
    slidesWithImages.add(Math.floor(n / 2));
  }
}
const total = toPage - CONFIG.fromPage + 1;
if (images.size > 0) console.log(`取得済み ${images.size} ページをスキップします`);

/** 1スライド開いて、見えた画像をすべて保存する */
async function visit(page: Page, slide: number): Promise<void> {
  await openSlide(page, slide);
  await waitSlide(page, slide);

  // harvest は前後のスライドぶんも返すので、空振りかどうかは目的のスライドで判断する
  const found = await harvest(page, lastSlide);
  if (!found.some(([n]) => Math.floor(n / 2) === slide)) {
    emptyVisits.set(slide, (emptyVisits.get(slide) ?? 0) + 1);
  }

  let added = 0;
  for (const [n, dataUri] of found) {
    slidesWithImages.add(Math.floor(n / 2));
    if (!wanted(n) || images.has(n)) continue;
    await Bun.write(shotPath(n), Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64"));
    images.set(n, shotPath(n));
    added++;
  }
  console.log(`[${String(images.size).padStart(String(total).length)}/${total}] スライド${slide} +${added}`);
}

/** スライド単位で巡回する。1スライド＝2ページ */
let cursor = Math.floor(CONFIG.fromPage / 2);

async function worker(page: Page): Promise<void> {
  while (true) {
    const slide = cursor++;
    if (slide > lastSlide || slide * 2 > toPage) return;

    // 受け持ちページがすべて手元にある（別のタブが先に回収した）なら開く必要はない
    const owned = slide === 0 ? [0, 1] : [slide * 2, slide * 2 + 1];
    if (owned.every((n) => !wanted(n) || images.has(n))) continue;

    try {
      await visit(page, slide);
    } catch (error) {
      // ここで落ちても後段の取りこぼし回収で拾い直す
      console.log(`  スライド${slide}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (CONFIG.intervalMs > 0) await sleep(CONFIG.intervalMs);
  }
}

const workers: Promise<void>[] = [];
for (let i = 0; i < CONFIG.concurrency; i++) {
  workers.push(worker(context.pages()[i] ?? (await context.newPage())));
}
await Promise.all(workers);

// ---- 取りこぼしを拾い直す ----

/** まだ手元にないページ番号 */
function missingPages(): number[] {
  const list: number[] = [];
  for (let n = CONFIG.fromPage; n <= toPage; n++) if (!images.has(n)) list.push(n);
  return list;
}

for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
  const missing = missingPages();
  if (missing.length === 0) break;
  console.log(`取りこぼし ${missing.length} ページを再取得します（${attempt}/${CONFIG.retries}）`);

  // 2回開いて1枚も出てこないスライドは空きスライド。何度開いても結果は変わらない
  const slides = [...new Set(missing.map((n) => Math.floor(n / 2)))].filter(
    (slide) => (emptyVisits.get(slide) ?? 0) < 2,
  );
  if (slides.length === 0) break;

  for (const slide of slides) {
    await visit(probe, slide).catch(() => {}); // 次の周回で拾う
  }
}

await context.close();

// ---- 結果 ----

// 画像を1枚も持たないスライドは、見開きの配置合わせに使われる空きスライド。
// そのページ番号は欠番であって、取得の失敗ではない。
const remaining = missingPages();
const blank = remaining.filter((n) => !slidesWithImages.has(Math.floor(n / 2)));
const failed = remaining.filter((n) => slidesWithImages.has(Math.floor(n / 2)));

console.log(`\n取得完了 ${images.size} ページ（${((Date.now() - started) / 1000).toFixed(1)}秒）`);
if (blank.length > 0) console.log(`ビューアに無いページ（欠番）: ${blank.join(", ")}`);

// 本当に取り損ねたページがあるならPDFは作らず画像も残す（抜けのあるPDFを残さないため）
if (failed.length > 0) {
  console.log(`取得できなかったページ: ${failed.join(", ")}`);
  console.log("もう一度実行すると、欠けているページだけ取りに行きます。");
  process.exit(1);
}

if (!CONFIG.createPdf || images.size === 0) process.exit(0);

// ---- PDF作成 ----

const pdfPath = CONFIG.pdfPath ?? (await autoPdfPath());
console.log(`PDFを作成中（${images.size}ページ）→ ${pdfPath}`);

const pdf = await PDFDocument.create();
const order = [...images.keys()].sort((a, b) => a - b);
for (const [i, n] of order.entries()) {
  // JPEGはそのまま埋め込めるので速い（PNGだと展開して再圧縮することになる）
  const image = await pdf.embedJpg(await Bun.file(images.get(n)!).bytes());
  pdf.addPage([image.width, image.height]).drawImage(image, {
    x: 0,
    y: 0,
    width: image.width,
    height: image.height,
  });
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${order.length} ページ`);
}
await Bun.write(pdfPath, await pdf.save());

console.log(`PDFを保存しました → ${pdfPath}（${(Bun.file(pdfPath).size / 1048576).toFixed(1)} MB）`);

// ---- 画像の片付け（PDFを書き終えたあとだけ） ----

if (!CONFIG.keepImages) {
  let removed = 0;
  for (const file of images.values()) {
    await unlink(file).then(
      () => removed++,
      () => {}, // すでに無い等は無視
    );
  }
  console.log(`画像を削除しました（${removed} 枚）`);
}
