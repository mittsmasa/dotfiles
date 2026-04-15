# html2pptx リファレンス

html2pptx は Anthropic pptx skill 内のライブラリ。HTML → PowerPoint 変換を行う。

## パス解決

html2pptx.js のパスは動的に解決する:

```bash
find ~/.claude/plugins -path '*/pptx/scripts/html2pptx.js' -not -path '*/node_modules/*' 2>/dev/null | head -1
```

thumbnail.py:
```bash
find ~/.claude/plugins -path '*/pptx/scripts/thumbnail.py' -not -path '*/node_modules/*' 2>/dev/null | head -1
```

## 依存パッケージ

グローバルまたはプロジェクトローカルに必要:
- `pptxgenjs` (npm)
- `playwright` (npm)
- `sharp` (npm)

## HTML スライドの書き方

### レイアウトサイズ

body に必ず指定:
- **16:9**: `width: 720pt; height: 405pt`
- **4:3**: `width: 720pt; height: 540pt`

### テキストルール

**全テキストは `<p>`, `<h1>`-`<h6>`, `<ul>`, `<ol>` 内に配置する。**
- `<div>` 直下のテキストは PowerPoint で無視される
- `<span>` 直下のテキストも無視される

```html
<!-- OK -->
<div><p>テキスト</p></div>

<!-- NG — テキストが消える -->
<div>テキスト</div>
```

### インラインフォーマット

`<b>`, `<i>`, `<u>` タグ、または `<span>` の CSS:
- `font-weight: bold`, `font-style: italic`, `text-decoration: underline`, `color: #rrggbb`
- `<span>` の `margin`, `padding` は未対応

### フォント

web-safe のみ: Arial, Helvetica, Times New Roman, Georgia, Courier New, Verdana, Tahoma, Trebuchet MS, Impact

### リスト

手動のバレット記号（•, -, *）を使わない。`<ul>` / `<ol>` を使う。

### 図形（div のみ）

background, border, border-radius, box-shadow は `<div>` にのみ有効。テキスト要素には効かない。

### 使えないもの

- CSS グラデーション（`linear-gradient`, `radial-gradient`）→ Sharp で PNG にラスタライズ
- カスタムフォント → web-safe font を使用

### プレースホルダー

```html
<div id="chart" class="placeholder" style="width: 350pt; height: 200pt;"></div>
```

返り値の `placeholders` 配列で位置を取得し、PptxGenJS で chart/image を配置。

## ビルドスクリプトのテンプレート

```javascript
const pptxgen = require('pptxgenjs');
const path = require('path');

// html2pptx のパスを動的解決
const { execSync } = require('child_process');
const h2pPath = execSync(
  "find ~/.claude/plugins -path '*/pptx/scripts/html2pptx.js' -not -path '*/node_modules/*' 2>/dev/null | head -1"
).toString().trim();
const html2pptx = require(h2pPath);

async function build() {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = 'TITLE';

  const slidesDir = path.join(__dirname, 'slides');
  const slideCount = SLIDE_COUNT;

  for (let i = 1; i <= slideCount; i++) {
    const num = String(i).padStart(2, '0');
    const htmlFile = path.join(slidesDir, `slide${num}.html`);
    console.log(`Processing slide ${i}...`);
    await html2pptx(htmlFile, pptx);
  }

  await pptx.writeFile({ fileName: 'OUTPUT.pptx' });
  console.log('Done');
}

build().catch(err => { console.error(err); process.exit(1); });
```

## サムネイル検証

```bash
python PATH_TO_THUMBNAIL_PY output.pptx thumbnails --cols 4
```

生成されたサムネイルグリッドを読み取って確認:
- テキスト切れ / はみ出し
- テキスト重なり
- コントラスト不足

## PptxGenJS の色指定

`#` プレフィックス不可。`"FF0000"` のように 6桁 hex で指定する（`"#FF0000"` はファイル破損の原因）。
