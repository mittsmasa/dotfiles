# Slidev リファレンス

デッキは Slidev(https://sli.dev/)で作る。デザインは `assets/slidev-template/` に固定してあり、本文は `slides.md` に Markdown で書く。export(PDF / PNG への書き出し)は `slidev export` が内部で Playwright を使って行う。

## セットアップ

```bash
cp -R ~/.agents/skills/slide/assets/slidev-template <作業ディレクトリ>/slides
cd <作業ディレクトリ>/slides
pnpm install
```

- `npx` はこの環境では使えない。`pnpm exec` / `pnpm <script>` を使う
- `pnpm install` と `slidev export` は sandbox 内だと失敗する(pnpm の store ロック、export が内部で立てる dev server)。sandbox 外で実行する
- `pnpm-workspace.yaml` の `allowBuilds` は `playwright-chromium` の postinstall(Chromium 取得)を許可するための設定。消すと `pnpm install` が `ERR_PNPM_IGNORED_BUILDS` で exit 1 になる
- テンプレート同梱の `slides.md` はコンポーネントのショーケース。書き始める前に中身を読んでから、本文で上書きする
- `style.css` / `layouts/` / `components/` はデッキ側で編集しない。デザインを変えるならテンプレート側を直す

### Chromium

`playwright-chromium` が要求するリビジョンは `node_modules/playwright-core/browsers.json` の `chromium` に書いてある。キャッシュにあれば何もしなくてよい。

```bash
ls ~/Library/Caches/ms-playwright/ | grep chromium
```

無ければ `pnpm exec playwright-chromium install chromium`。

## slides.md の書き方

- スライドの区切りは `---`。先頭の frontmatter(headmatter)はテンプレートのまま変えない(`theme: none` / `canvasWidth: 1280` / Noto Sans JP)
- 1 枚目は `layout: cover`(headmatter に書いてある)。2 枚目以降は default レイアウト(window-bar 付き)
- 発表者ノートはスライド末尾の `<!-- -->`。骨子(slide.md)のノート欄をここへ移す
- HTML ブロックの中で Markdown を書くときは、前後に空行を入れる。空行が無いと Markdown として解釈されない
- 骨子ファイル `slide.md`(slide-outline が作る)と、Slidev の本文 `slides.md` は別物。取り違えない

## export

```bash
pnpm pdf   # → deck.pdf(slidev export --output deck.pdf)
pnpm png   # → png/1.png ...(2560x1440、目視確認用)
```

- 特定のページだけ欲しいときは `pnpm exec slidev export --format png --range 3,5-6`
- PPTX が要るときは `pnpm exec slidev export --format pptx`(各ページを画像で貼った pptx。テキスト編集はできない)
- export 中に `Failed to patch FloatingVue` が console.error に出るが、出力には影響しない

## 目視検証

`png/*.png` を Read ツールで開いて確認する。観点:

- テキストの見切れ・はみ出し(特に SVG 内のラベル)
- ページ間で同じ要素の位置ズレ(Key Message の有無で図が動いていないか)
- 余白の間延び、要素の端寄り
- Key Message が紙面下にはみ出していないか(図が大きすぎるとき起きる)

## SVG 矢印を HTML 要素の位置に正確に合わせる

矢印の終点を目分量で決めると大抵ズレる。dev server を立ててレンダリングし、`boundingBox()` で実座標を取る。

```bash
pnpm exec slidev --port 3031 --open false   # sandbox 外・バックグラウンドで起動
```

```javascript
// measure.mjs(デッキのディレクトリに一時的に置いて node で実行し、終わったら消す)
import { chromium } from 'playwright-chromium';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:3031/4', { waitUntil: 'networkidle' }); // 4 = ページ番号
await page.evaluate(() => document.fonts.ready);

// 前後のページも DOM に残っているので :visible で表示中のページに絞る
const base = await page.locator('.diagram:visible').boundingBox(); // 矢印オーバーレイの基準要素
for (const t of await page.locator('.chip:visible').all()) {
  const b = await t.boundingBox();
  console.log({ x: b.x - base.x, y: b.y - base.y, w: b.width, h: b.height });
}
await browser.close();
```

- ビューポートを 1280x720 にすると紙面が等倍で描かれ、取れた座標がそのまま紙面座標になる。別サイズにすると紙面が拡大縮小されるので変えない
- `?print` 付きの URL は全ページを並べる表示で、座標が紙面基準にならない。使わない
- 矢印は要素の中心ではなく縁(上端など)を終点にする。中心まで伸ばすと図形やテキストを突き抜けて見える
- 測り終えたら dev server を `kill <pid>` で止め、measure.mjs を消す
