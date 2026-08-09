# html2pdf リファレンス

Playwright スクリーンショット + pdf-lib で HTML スライドを PDF 化する。CSS のフル機能(疑似要素、SVG、Google Fonts、絵文字)が使える。

## 依存

- `playwright-core` + `pdf-lib`(npm)。作業用ディレクトリ(scratchpad 等)に `npm i playwright-core pdf-lib`
- ブラウザ本体は playwright のキャッシュを使う。ダウンロード不要なことが多い:

```bash
ls ~/Library/Caches/ms-playwright/ | grep chromium_headless_shell
# → chromium_headless_shell-<rev>/chrome-headless-shell-mac-arm64/chrome-headless-shell
```

キャッシュが無ければ `npx playwright-core install chromium-headless-shell`。

## ビルドスクリプトのテンプレート

```javascript
// build-pdf.mjs
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const SLIDES_DIR = '/abs/path/to/slides';
const OUT = join(SLIDES_DIR, 'deck.pdf');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-<rev>/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const files = readdirSync(SLIDES_DIR).filter(f => /^slide\d+\.html$/.test(f)).sort();
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });

const pdf = await PDFDocument.create();
for (const f of files) {
  await page.goto('file://' + join(SLIDES_DIR, f), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  const img = await pdf.embedPng(await page.screenshot({ type: 'png' }));
  const p = pdf.addPage([1280, 720]);
  p.drawImage(img, { x: 0, y: 0, width: 1280, height: 720 });
}
await browser.close();
writeFileSync(OUT, await pdf.save());
```

ポイント:

- `deviceScaleFactor: 2` で 2 倍解像度のスクリーンショットを 1280x720pt のページに埋める(文字がくっきりする)
- `document.fonts.ready` を待たないと Noto Sans JP 適用前に撮れてしまう
- スクリプトや `node_modules` は scratchpad に置き、成果物(PDF)だけをリポジトリへ出す

## 目視検証

`pdftoppm`(poppler)が無い環境では、同じ Playwright セッションで各スライドの PNG を scratchpad に保存し、画像として確認する(Read ツールで PNG を開ける)。確認観点:

- テキストの見切れ・はみ出し(特に SVG 内のラベル)
- ページ間で同じ要素の位置ズレ
- 余白の間延び、要素の端寄り

## SVG矢印をHTML要素の位置に正確に合わせる

エージェントのノードからチップ・ラベルなど特定の要素へ矢印を伸ばすとき、終点の座標を目分量で決めると大抵ズレる(手前の別要素を突っ切る、要素の中心まで刺さり込む等)。スクリーンショットで確認しながら数値を勘で調整するより、実際にレンダリングして `boundingBox()` で座標を取るほうが早い:

```javascript
// measure.mjs
import { chromium } from 'playwright-core';
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-<rev>/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('file:///abs/path/to/slideNN.html', { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

const containerBox = await page.locator('.diagram').boundingBox(); // 矢印オーバーレイの基準にする要素
const targets = await page.locator('.chip').all();
for (const t of targets) console.log(await t.boundingBox());
await browser.close();
```

- 矢印オーバーレイ svg の座標系は、基準にした要素(上記の `.diagram`)の左上を原点にする。取得した `boundingBox()` の x/y からその要素の x/y を引けば、オーバーレイのローカル座標に変換できる
- 矢印は要素の**中心**ではなく**縁(上端など)**を終点にする。中心まで伸ばすと図形やテキストを突き抜けて見える
- 測定用スクリプトは scratchpad に置き、確認が終わったら削除する(成果物に残さない)
