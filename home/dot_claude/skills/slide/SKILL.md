---
name: slide
description: "スライドデッキ（HTML → PPTX）を生成する。モノトーン + macOS ウィンドウバー風の固定デザイン。「スライド作って」「プレゼン作って」「/slide テーマ名」等でトリガー。"
accepts_args: true
---

# /slide - スライドデッキ生成

モノトーンデザインの HTML スライドデッキを生成し、html2pptx で PPTX に変換する。

## 入力

`$ARGUMENTS`: テーマ名、構成指示、または原稿テキスト。

## ワークフロー

1. **構成設計** — スライド構成案を提示、ユーザー承認を得る
2. **HTML 生成** — 下記デザインシステムに準拠して `slides/slideNN.html` を生成
3. **PPTX ビルド** — ビルドスクリプト作成・実行。詳細は [references/html2pptx.md](references/html2pptx.md)
4. **サムネイル検証** — thumbnail.py でグリッド生成、視覚確認。問題あれば修正・再ビルド

## デザインシステム

### 基本仕様

- サイズ: `width: 720pt; height: 405pt`（16:9）
- フォント: Arial（web-safe）
- カラー: #1A1A1A / #555 / #999 / #F9F9F9 / #FFF
- 実装例: [assets/design-system.html](assets/design-system.html)

### 共通構造（html2pptx 向け）

```html
<!DOCTYPE html>
<html>
<head>
<style>
html { background: #ffffff; }
body {
  width: 720pt; height: 405pt; margin: 0; padding: 0;
  background: #ffffff; font-family: Arial, sans-serif;
  display: flex; flex-direction: column;
}
.window-bar {
  background: #1a1a1a; height: 28pt; display: flex; align-items: center;
  padding: 0 12pt; flex-shrink: 0;
}
.dot { width: 10pt; height: 10pt; border-radius: 50%; margin-right: 6pt; }
.dot-red { background: #FF5F57; }
.dot-yellow { background: #FFBD2E; }
.dot-green { background: #27C93F; }
.content {
  flex: 1; display: flex; flex-direction: column;
  padding: 16pt 40pt;
}
</style>
</head>
<body>
<div class="window-bar">
  <div class="dot dot-red"></div>
  <div class="dot dot-yellow"></div>
  <div class="dot dot-green"></div>
</div>
<div class="content">
  <!-- スライド内容 -->
</div>
</body>
</html>
```

### タイポグラフィ

| 要素 | サイズ | ウェイト | 色 | 装飾 |
|---|---|---|---|---|
| タイトル h2 | 30pt | 900 | #1A1A1A | border-bottom: 4px solid |
| サブタイトル h3 | 15pt | 400 | #555 | border-left: 4px solid, padding-left |
| セクション見出し | 10pt | 700 | #1A1A1A | — |
| 本文 | 9-10pt | 400 | #333 | line-height: 1.6 |
| ラベル | 8pt | 700 | #999 | uppercase |

### コンポーネント

**箇条書き**: `<ul><li>` を使用。手動バレット記号（•, -, *）禁止。

**ハイライトボックス（ライト）**: `<div>` に bg: #F9F9F9, border: 1px solid #EEE, border-radius: 8pt, padding: 5-8pt。テキストは `<p>` で。補足・引用・具体例に使用。

**ハイライトボックス（ダーク）**: `<div>` に bg: #1A1A1A, color: #FFF, border-radius: 8pt, padding: 5-8pt。テキストは `<p>` で。結論・重要メッセージに使用。

**テーブル**: ヘッダ行は bg: #1A1A1A + 白文字。行は border-bottom: 1pt solid #E8E8E8。

**プレースホルダー**: `class="placeholder"` で PptxGenJS チャート/画像を後から配置。

**2カラム**: `display: flex; justify-content: space-between;` で width: 48% ずつ。

### レイアウトパターン

1. **タイトル** — タイトル + サブタイトル中央配置
2. **見出し + 本文** — h2 + h3 + テキスト/箇条書き
3. **見出し + 2カラム** — 比較、テキスト+図
4. **見出し + テーブル** — データ比較
5. **見出し + 図表** — h2 + h3 + placeholder
6. **ダーク強調** — キーメッセージを黒背景ボックスで

### 注意

- テキストは必ず `<p>`, `<h1>`-`<h6>`, `<ul>`, `<ol>` 内に（`<div>` 直下は無視される）
- CSS グラデーション不可（Sharp で PNG にラスタライズ）
- background/border/box-shadow は `<div>` のみ有効
