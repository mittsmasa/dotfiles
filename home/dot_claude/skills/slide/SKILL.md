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

## レイアウト原則

コンポーネント単体のデザインが正しくても、配置がページごとにブレると資料全体が素人くさくなる。以下を全スライドで守る。

- **骨子(slide.md)の表現形式指定に従う**。骨子の「載せる」に箇条書き / 表 / 対比リスト / 図などの形式が書かれていればその通りに作る。指定が無いスライドは、形式を提案して骨子側に書き戻してから html 化する(html 側で表現を発明しない)
- **タイトルスライドを1枚目に置く**。骨子側にタイトルが無ければ「後で決める(仮)」のまま作る
- **Key Message はライトボックス(グレー背景 #F9F9F9 + 細ボーダー、太字、中央寄せ)で紙面の最下部・全幅に統一**。上に置いたり左に寄せたりしない。聞き手の視線の置き場を固定するため
- **ボックスの使い分けに論理を通す**。ボックスは Key Message 専用にする。本文・例示・補足は箇条書きで書く(プレーンテキスト)。「なんとなく囲む」とボックスの意味が失われ、読み手がどれが結論か判別できなくなる
- **黒背景は図の要素(プロセスのノード、エージェント等)専用**。紙面の文を黒背景ボックスで強調すると図と見た目が被り、図なのか文なのか区別がつかなくなる
- **同じ図をページ間で再掲するときは、同じ位置・同じサイズ・同じ要素の並び順で出す**。図の再登場は「あの話がこう変わる」の対比装置なので、位置や順序がズレると対比が壊れる。積み増し系(吹き出しが増える等)は、要素が無いページでも同じグリッドを敷いて位置を固定する(Key Message が無いページには同じ高さの透明スペーサーを置く)
- **文字は大きく、言葉は少なく**。本文の目安は 17px 以上。文が長くて入らないなら、縮小せずキーワード化する。話す内容は骨子(slide.md)のノート欄にあり、紙面に全部載せない
- **余白の間延びに注意**。中央や中段にぽっかり空白ができるレイアウトは、要素の justify を見直す。情報量が薄すぎるページは骨子側に戻して統合を提案する
- **要素を端に置き去りにしない**。左上に小さな要素がひとつ、のような配置は視線が迷子になる

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
| タイトル h1 | 54px以上 | 700 | #1A1A1A | — |
| 見出し h2 | 38px | 700 | #1A1A1A | border-bottom: 4px solid #1A1A1A |
| サブタイトル h3 | 20px | 400 | #555 | border-left: 4px solid #1A1A1A, padding-left: 15px |
| 本文(箇条書き) | 28px | 400 | #333 | 2カラム等の幅が細い場所は 22-24px。入らないなら縮小せずテキストを短くする |
| Key Message | 32px | 700 | #1A1A1A | グレーボックス(下記)、最下部・全幅・中央寄せ |
| テーブル | 21px | 400 | #333 | ヘッダのみ黒背景 |
| ラベル | 12px | 700 | #999 | uppercase, letter-spacing: 0.1em |

### コンポーネント

**箇条書き**: `list-style: none` + `li::before` 疑似要素で黒丸（10px, #1A1A1A）。`padding-left: 25px` で余白確保。

**ハイライトボックス（ライト）**: bg: #F9F9F9, border: 1px solid #E0E0E0, border-radius: 8px, padding: 14-16px。**Key Message 専用**(太字、中央寄せ、最下部)。補足・例示はボックスにせず箇条書きで書く。

**ハイライトボックス（ダーク）**: bg: #1A1A1A, color: #FFF, border-radius: 8px。図の要素(プロセスのノード、循環図の箱、知識チップ等)専用。紙面の文の強調には使わない(図と見た目が被るため)。

**吹き出し（台詞用）**: bg: #FFF, border: 1.5px solid #999, border-radius: 14px, しっぽ(::after の回転正方形) + box-shadow: 3px 3px 0 #EEE。グレー版(border #DDD, 文字 #BBB, 影なし)は「前のスライドの残像」表現に使う。Key Message のグレーボックスと見た目を分けるため、必ずしっぽを付ける。

**区画 + チップ**: 区画は border: 2px dashed #AAA の白背景(範囲・領域を表す)。中の概念ラベル(チップ)はダーク(黒)で図のノード扱い。区画・吹き出し・Key Message は3つとも別の見た目にする(グレー背景を共有すると役割が判別できなくなる)。

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
