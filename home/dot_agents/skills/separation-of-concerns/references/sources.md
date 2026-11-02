# separation-of-concerns: 出典

SKILL.md の各観点の出どころ。調査日 2026-11-02。

凡例: [一次] = 原典を直接確認 / [二次] = 要約記事・他文献経由（原典未確認） / [未検証] = 今回どの資料でも確認していない

---

## 1. Robert C. Martin「The Single Responsibility Principle」（2014） [一次]

URL: https://blog.cleancoder.com/uncle-bob/2014/05/08/SingleReponsibilityPrinciple.html

- 定義: "each software module should have one and only one reason to change."
- 変わる理由は人: "This principle is about people." / "the reasons for change are people. It is people who request changes."
- 変わる理由は、1 人か、まとまって動く 1 つのグループから来る: "a single tightly coupled group of people" "representing a single narrowly defined business function"
- バグ修正とリファクタは変わる理由に数えない: "Certainly the code is not responsible for bug fixes or refactoring."
- 言い換え: "Gather together the things that change for the same reasons. Separate those things that change for different reasons."
- 凝集度と結合度の言い換えでもある: "this is just another way to define cohesion and coupling."
- 例: `Employee` の `calculatePay`（CFO）/ `reportHours`（COO）/ `save`（CTO）。"we don't want to get the COO fired because we made a change requested by the CTO."
- 応用: "This is the reason we do not put SQL in JSPs."
- 本文に "actor" という語は出てこない。「アクター」は同氏の書籍（Clean Architecture）での言い方 [二次]

SKILL.md での使い先: 判定の軸、観点 1、観点 4（JSP に SQL を書かない）

## 2. Martin Fowler「PresentationDomainDataLayering」 [一次]

URL: https://martinfowler.com/bliki/PresentationDomainDataLayering.html

- 分ける最大の利点は、注意を向ける範囲を狭めること: "reduce the scope of my attention" / "The reduced scope of attention reason is sufficient on its own."
- 実装の差し替え: "substitute different implementations"。ただしデータ層の差し替えは "I rarely hear of someone actually doing it."
- モジュールの境界はテストの継ぎ目になる: "seams that are good affordance for testing"
- 依存の向き: "presentation depends on the domain, which then depends on the data source."
- 大きなシステムは先にドメインで分け、その中を層に分ける: "you should split your top level into domain oriented modules which are internally layered."
- 層は論理的な区分で、物理的な配置ではない: "These layers are logical layers not physical tiers."

SKILL.md での使い先: 判定の軸（読む範囲）、観点 4、観点 5、観点 7、観点 8（差し替えの予定がない層）

## 3. Edsger W. Dijkstra「On the role of scientific thought」（EWD447, 1974） [二次]

原典 URL: https://www.cs.utexas.edu/~EWD/transcriptions/EWD04xx/EWD447.html（証明書エラーで取得できず）
確認経路: Wikipedia「Separation of concerns」 https://en.wikipedia.org/wiki/Separation_of_concerns

- 用語の出どころ: "It is what I sometimes have called "the separation of concerns""
- 1 つの側面に注目しても、他の側面を無視するわけではない: "it does not mean ignoring the other aspects"
- Wikipedia の整理: 関心の分離はモジュール化より広い。モジュール化は関心の分離の一形態にすぎない

SKILL.md での使い先: 直接の引用はしていない。skill 名と、分割を目的にしない立場の背景

## 4. David L. Parnas「On the Criteria To Be Used in Decomposing Systems into Modules」（1972） [二次]

確認経路: 上記 Martin の記事の引用。PDF（https://wstomv.win.tue.nl/edu/2ip30/references/criteria_for_modularization.pdf）はスキャン画像でテキスト層がなく、読めなかった

- 変わりやすい設計判断を基準にモジュールを分ける: "design decisions which are likely to change"
- "Each module is then designed to hide such a decision from the others."

SKILL.md での使い先: 観点 4（外側の形を境界で隠す）

## 5. DRY の「知識の重複」 [未検証]

- 出典とされるもの: Andrew Hunt, David Thomas『The Pragmatic Programmer』
- 「DRY はコードの見た目の重複ではなく、知識の重複をなくす原則」という読み方は広く流布しているが、今回は原典も要約記事も確認していない

SKILL.md での使い先: 観点 3 の「見た目が同じコードの重複は、同じ知識の重複とは限らない」。SKILL.md では DRY の名前を出さず、主張だけを書いている

## 6. このスキル独自の整理

以下は上記の資料をもとに組み立てたもので、特定の出典はない。

- 8 観点の立て方と順序（1・2 が軸そのもの、3〜7 が症状、8 が逆方向の失敗）
- 「分けすぎも観点 2 と同じ失敗」という位置づけ
- 「行数・ファイル数では判定しない」
- 書くときの手順と、レビューで「どの人のどの要望で、どこが壊れるか」のシナリオを添える型
