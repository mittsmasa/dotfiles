---
name: slide
description: "スライドデッキ（HTML → PDF）を生成する。モノトーン + macOS ウィンドウバー風の固定デザイン。「スライド作って」「プレゼン作って」「/slide テーマ名」等でトリガー。"
accepts_args: true
---

# /slide - スライドデッキ生成

モノトーンデザインの HTML スライドデッキを生成し、Playwright + pdf-lib で PDF に変換する。

## 入力

`$ARGUMENTS`: テーマ名、構成指示、または原稿テキスト。

## ワークフロー

1. **構成設計** — スライド構成案を提示、ユーザー承認を得る
2. **HTML 生成** — 下記デザインシステムに準拠して `slides/slideNN.html` を生成
3. **PDF ビルド** — ビルドスクリプト作成・実行。詳細は [references/html2pdf.md](references/html2pdf.md)
4. **目視検証** — PDF を開いて確認。問題あれば修正・再ビルド

## デザインシステム

### 基本仕様

- サイズ: `width: 1280px; height: 720px`（16:9）
- フォント: Noto Sans JP（Google Fonts 読み込み）
- カラー: #1A1A1A / #555 / #999 / #F9F9F9 / #FFF
- 実装例: [assets/design-system.html](assets/design-system.html)

### 共通構造

```html
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&display=swap" rel="stylesheet">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: 1280px; height: 720px;
  background: #ffffff; font-family: 'Noto Sans JP', sans-serif;
  display: flex; flex-direction: column;
}
.window-bar {
  background: #1a1a1a; height: 40px; display: flex; align-items: center;
  padding-left: 20px; flex-shrink: 0;
}
.dot { width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
.dot-red { background: #FF5F56; }
.dot-yellow { background: #FFBD2E; }
.dot-green { background: #27C93F; }
.content {
  flex: 1; display: flex; flex-direction: column;
  padding: 40px 60px 18px;
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

### コンテンツ領域

window-bar（40px）+ padding 上下（58px）を除いた実効コンテンツ領域は **約 622px**。
h2 + h3 で約 120px 使うため、見出し付きスライドの本文領域は **約 500px**。
詰め込みすぎに注意。

### タイポグラフィ

| 要素 | サイズ | ウェイト | 色 | 装飾 |
|---|---|---|---|---|
| タイトル h1 | 54px | 700 | #1A1A1A | — |
| 見出し h2 | 38px | 700 | #1A1A1A | border-bottom: 4px solid #1A1A1A |
| サブタイトル h3 | 20px | 400 | #555 | border-left: 4px solid #1A1A1A, padding-left: 15px |
| 本文 | 15-18px | 400 | #333 | line-height: 1.5-1.7 |
| ラベル | 12px | 700 | #999 | uppercase, letter-spacing: 0.1em |

### コンポーネント

**箇条書き**: `list-style: none` + `li::before` 疑似要素で黒丸（10px, #1A1A1A）。`padding-left: 25px` で余白確保。

**ハイライトボックス（ライト）**: bg: #F9F9F9, border: 1px solid #EEE, border-radius: 8px, padding: 16px。補足・引用・具体例に使用。

**ハイライトボックス（ダーク）**: bg: #1A1A1A, color: #FFF, border-radius: 8px, padding: 16px。結論・重要メッセージに使用。

**テーブル**: ヘッダ行は bg: #1A1A1A + 白文字。行は border-bottom: 1px solid #E8E8E8。font-size: 15px。

**プレースホルダー**: bg: #F0F0F0, border: 2px dashed #CCC, border-radius: 8px。画像や図表の配置場所を示す。

**2カラム**: `display: flex; justify-content: space-between;` で width: 48% ずつ。

### レイアウトパターン

1. **タイトル** — h1 + h3 中央配置
2. **見出し + 本文** — h2 + h3 + テキスト/箇条書き
3. **見出し + 2カラム** — テキスト+画像、比較など
4. **見出し + テーブル** — データ比較
5. **見出し + ボックス** — ライト/ダークボックスの組み合わせ
6. **ダーク強調** — キーメッセージを黒背景ボックスで全面配置

### CSS の自由度

PDF 出力（Playwright スクリーンショット）のため、HTML/CSS のフル機能が使える:

- `::before` / `::after` 疑似要素 OK
- border / background / box-shadow はどの要素にも適用可
- Google Fonts 読み込み OK
- CSS グラデーション OK（ただしデザインシステム的には非推奨）
