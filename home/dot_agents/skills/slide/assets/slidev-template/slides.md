---
theme: none
title: デザインコンポーネント集
canvasWidth: 1280
aspectRatio: 16/9
colorSchema: light
transition: none
fonts:
  sans: Noto Sans JP
  weights: '400,700'
layout: cover
---

# デザインコンポーネント集

### タイトルスライド(cover レイアウト): h1 54px + h3

<!--
発表者ノートは各スライド末尾の HTML コメントに書く。骨子(slide.md)のノート欄をここへ移す。
-->

---

## 見出し h2(38px / 下線)

### サブタイトル h3(20px / 左バー)。使用は任意

- キーワードだけの短い箇条書き。**強調は太字**で
  - 補足はサブ項目(22px、小さいドット)
- 本文・例示・補足はすべて箇条書き。ボックスで囲まない

<KeyMessage>Key Message はこのグレーボックスに</KeyMessage>

---

## 図の要素(黒背景はここだけ)

### プロセスのノード、循環図の箱、エージェント、知識チップ

<div class="fig">
<div class="fig-row">
  <div class="stage">企画</div><span class="arr">→</span>
  <div class="stage">デザイン</div><span class="arr">→</span>
  <div class="stage">開発</div><span class="arr">→</span>
  <div class="stage">QA</div>
</div>
</div>

<KeyMessage spacer />

---

## 吹き出しと区画

### 吹き出し = 台詞(グレー版は前スライドの残像)。区画 = 範囲、チップ = 図のノード

<div class="fig" style="flex-direction: column; gap: 40px;">
<div class="fig-row" style="gap: 48px; align-items: flex-start;">
  <div class="fig-row" style="flex-direction: column; align-items: flex-start; gap: 28px;">
    <p class="bubble">既存のデータ構造が歪みそう...</p>
    <p class="bubble dim">前のスライドの吹き出し</p>
  </div>
  <div class="room"><p class="name">開発</p><p class="chip">データモデル</p></div>
  <div class="room"><p class="name">QA</p><p class="chip">テスト観点</p></div>
</div>
<div class="fig-row" style="gap: 28px;">
  <span class="tool"><span class="tile">Cf</span>Confluence</span>
  <span class="tool"><span class="tile">Fg</span>Figma</span>
  <span class="tool"><span class="tile">GH</span>GitHub</span>
</div>
</div>

<KeyMessage spacer />

---

## テーブル(21px / ヘッダのみ黒)

| 役割 | 紐づく知識 |
|---|---|
| 企画 | ユーザーのメタ的な情報・要望、ドメイン知識 |
| 開発 | データモデル、既存実装の制約 |
| QA | テスト観点、過去の不具合 |

<KeyMessage>表は Markdown のテーブル記法で書く</KeyMessage>

---

## 目次(中扉)

<ol class="agenda">
  <li class="done">1. 話し終えた章 ✓</li>
  <li class="now">2. いま話している章</li>
  <li>3. これから話す章</li>
</ol>

---

## 対比の箇条書きと 2 カラム

<div class="cols">
<div>

- **問題の名前** → それへの向き合い方
- **もう一つの問題** → 向き合い方

</div>
<div>

- 2 カラムの本文は 24px
- HTML の中で Markdown を書くときは前後に空行

</div>
</div>

<div class="fig">
<div class="placeholder">IMAGE / DIAGRAM AREA</div>
</div>

<KeyMessage>対比は「太字リード → 向き合い方」の形</KeyMessage>
