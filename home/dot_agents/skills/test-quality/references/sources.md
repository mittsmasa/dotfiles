# test-quality: 原典別の詳細と出典

SKILL.md の各観点の出どころ。調査日 2026-10-28。

凡例: [一次] = 原典を直接確認 / [二次] = 要約記事・書籍紹介経由（原典未確認）

---

## 1. FE/BE 共通の観点

### 1-1. Kent Beck「Test Desiderata」12 特性 [一次]

| 特性 | 意味 |
|---|---|
| Isolated | 実行順に関係なく同じ結果になる |
| Composable | 変化の次元を個別にテストし、結果を組み合わせられる |
| Deterministic | 何も変わらなければ結果も変わらない（flaky でない） |
| Fast | 速く走る |
| Writable | 対象コードに比べて書くコストが低い |
| Readable | 読めば「なぜこのテストがあるか」がわかる |
| Behavioral | 振る舞いが変われば結果が変わる |
| Structure-insensitive | コード構造が変わっても結果が変わらない |
| Automated | 人手なしで走る |
| Specific | 失敗時に原因が明白 |
| Predictive | 全部通ればプロダクションに出せる |
| Inspiring | 通ると自信が持てる |

- これらはチェックリストではなく、互いに引っ張り合うスライダー。TDD とは独立の概念（Beck 本人の言） [二次]

### 1-2. Vladimir Khorikov「良い単体テストの 4 本柱」 [二次]

出典: *Unit Testing: Principles, Practices, and Patterns*（Manning, 2020）4 章

1. 回帰からの保護（バグを検出できるか）
2. リファクタリングへの耐性（偽陽性＝誤アラームを出さないか）
3. 速いフィードバック
4. 保守性（読みやすさ・実行の容易さ）

- テストの価値 ≒ 4 つのスコアの**掛け算**。どれかが 0 なら価値は 0
- 1〜3 は同時に最大化できない。**リファクタ耐性と保守性は常に最大化**し、回帰保護と速さの間で調整する
- 実装詳細への結合が強いほど偽陽性が増える

### 1-3. Google『Software Engineering at Google』12 章 [一次]

- **Unchanging tests**: 一度書いたテストは、要件が変わったときだけ変更が要る状態を目指す（リファクタ・バグ修正・機能追加では変えずに済む）
- **公開 API 経由でテスト**する（ユーザーと同じ呼び方）
- **インタラクションより状態を検証**する（モック呼び出しの検証は壊れやすい）
- **メソッド単位ではなく振る舞い単位**で 1 テスト。given / when / then で構成
- **テスト名は振る舞いと期待結果**を書く。名前に「and」が要るなら分割のサイン
- **テストにロジックを書かない**（ループ・条件分岐・凝った文字列組み立てを避ける）
- **失敗メッセージを明確に**（期待値・実際値・関連パラメータ）
- **DRY より DAMP**: 読みやすさのための重複は許容。共通ヘルパーは「短くする」ためでなく「説明的にする」ために使う
- 共通 setup はデフォルト構築にとどめ、テストが依存する値はテスト内に明示する

### 1-4. Google: テストサイズと flaky [二次]

- サイズ（small / medium / large）= 使ってよい資源（プロセス・ネットワーク・I/O）。スコープ（unit / integration / E2E）= 検証するコード量。**2 つは別軸**
- 1 週間の計測で flaky 率: small 0.5% / medium 1.6% / large 14%。サイズが大きいほど決定性が落ちる
- Hermetic（必要な依存をすべてテスト自身が宣言・用意する）であることが再現性の前提

### 1-5. 和田卓人（t-wada）氏の整理 [二次]

- 連載「サバンナ便り」（gihyo.jp）: 信頼できる結果に短時間でたどり着くテスト群をどう作るか。テストピラミッド、テストダブルによるテストサイズの縮小を扱う
- 偽陽性（正しいコードで失敗）と偽陰性（誤ったコードで成功）を区別して考える
- 「良いテストの条件」を直接列挙した t-wada 氏の資料は今回の検索では見つからなかった（探索範囲: Web 検索 2 回）

---

## 2. フロントエンド固有の観点

### 2-1. Testing Library の指導原則 [一次]

- 「テストがソフトウェアの使われ方に似るほど、得られる自信は大きくなる」
- コンポーネントインスタンスではなく DOM ノードを扱う。ユーザーと同じ操作で検証する
- **クエリの優先順位**:
  1. 誰でもアクセスできるもの: `getByRole` > `getByLabelText` > `getByPlaceholderText` > `getByText` > `getByDisplayValue`
  2. セマンティック: `getByAltText` > `getByTitle`
  3. 最終手段: `getByTestId`
- 副次効果: role / label で引けない UI はアクセシビリティ上の問題を示唆する

### 2-2. Kent C. Dodds「Testing Trophy」 [一次]

- 下から Static（型・lint）→ Unit → **Integration（最も厚い）** → E2E
- 「Write tests. Not too many. Mostly integration.」
- 投資対効果（自信 ÷ コスト）で配分を決める。比率の公式な定めはない
- 単一コードベース（モノリス）前提の考え方と本人が明言

### 2-3. 実務的なプラクティス [二次]

- **ネットワーク層でモックする**（MSW）。内部関数や hooks をモックしない
- **コンポーネント全体のスナップショットは避ける**。構造に敏感で信号が弱い。例外はシリアライズ結果や生成設定
- **VRT は対象を絞る**（デザインシステム、重要ページ）。動的コンテンツで flaky になりやすく保守コストが高い
- **jsdom はレイアウトを描画しない**。レイアウト・ブラウザ API 依存の振る舞いは実ブラウザ（Playwright / Vitest browser mode）で
- axe-core で a11y の機械的検出。ただしスクリーンリーダーでの手動確認の代わりにはならない

---

## 3. バックエンド固有の観点

### 3-1. 管理下依存 / 管理外依存（Khorikov） [二次]

- **管理下依存**（自アプリだけが触る DB など）: モックせず本物で統合テストする
- **管理外依存**（外部 API、SMTP、他システムと共有するメッセージバス）: 外部から観測できる相互作用なのでテストダブルで置き換え、呼び出しを検証する
- 「モックは管理外依存にだけ使う」を守るだけでモック由来の脆さの大半を避けられる、と Khorikov
- 例外: ブローカーのフォーマット互換確認などで、管理外依存に本物を当てる価値がある場面もある

### 3-2. 統合テストの実務 [二次]

- **使い捨てコンテナで本物の依存を立てる**（Testcontainers）。再現性のある DB / 外部サービス環境
- **テスト間で状態をリセット**（トランザクションのロールバック or クリーンアップ）。Isolated を担保
- **異常系を必ず含める**: 想定外の HTTP ステータス、タイムアウト、遅延応答（Zalando）
- **サービス境界は契約テスト**（Pact などの consumer-driven contract）。ただし後方互換の問題は契約テストだけでは拾えないので E2E と補完
- 統合テストをテストスイートの中心にしない（Zalando）。配分は Trophy（FE 寄り）と Pyramid（BE 寄り）で考え方が異なる

---

## 4. 書かない判断の根拠

### 4-1. 実装の写し（Tautological test / The Ugly Mirror） [二次]

- 期待値を実装と同じ方法で計算すると、実装の誤りが期待値にも同じだけ入り、テストは構造上必ず通る。例: `expect(add(a, b)).toBe(a + b)`
- 対策: 期待値は実装の外（仕様、手計算した具体例、既知のリテラル）から取る
- モック中心のテストも「実装の鏡」になりやすい。実装を変えると期待（モックの設定と検証）も一緒に書き換わり、振る舞いについて何も言わないまま通り続ける（J. B. Rainsberger による Fabio Pereira の批判の紹介）
- 反論: 協調者とのやりとりがごく単純なオブジェクトでは、この重複はさほど問題にならないという見方もある（同記事）

### 4-2. コードの 4 象限（Khorikov 7 章） [二次・原典未確認]

縦軸を複雑さ（ドメイン上の重要度）、横軸を協調者の数とした 4 分類。

| 象限 | 扱い |
|---|---|
| ドメインモデル・アルゴリズム（複雑・協調者少） | 単体テストの主対象 |
| controller（単純・協調者多） | 少数の統合テストで覆う |
| 自明なコード（単純・協調者少） | テストしない |
| 複雑すぎるコード（複雑・協調者多） | ドメインと controller に分割してから上の扱いにする |

書籍 1 章の抜粋 PDF で「単体テストはドメインモデルとアルゴリズムに使う」「controller は別扱い」までは確認した。4 象限の詳細は書籍の要約に基づく。

### 4-3. その他

- Google『SWE at Google』12 章: インタラクションより状態を検証する。モックフレームワークに頼るインタラクションテストは壊れやすい [一次]
- Kent C. Dodds: 「Write tests. Not too many. Mostly integration.」 [一次]
- 「フレームワークやライブラリ自体の挙動を確かめない」は、実務で広く言われる経験則として載せた。特定の原典は確認していない

---

## 5. 観点が対立する点（判断が必要なところ）

| 対立 | 内容 |
|---|---|
| Pyramid vs Trophy | BE は単体厚め、FE は統合厚めが主流。単一の正解比率はない |
| 速さ vs 予測性 | 本物の依存を使うほど Predictive だが遅く flaky になりやすい |
| DRY vs DAMP | Google は読みやすさのための重複を推奨 |
| モックの範囲 | London 学派（協調者をモック）vs Classical 学派（管理外依存のみモック）。Khorikov / Google は後者寄り |

---

## Sources

- [Test Desiderata (Kent Beck)](https://testdesiderata.com/)
- [Desirable Unit Tests - Kent Beck newsletter](https://newsletter.kentbeck.com/p/desirable-unit-tests)
- [4 Pillars of Good Unit Tests (notesbylex)](https://notesbylex.com/4-pillars-of-good-unit-tests)
- [How to assess the value of a unit test (talon.one)](https://talon.one/blog/how-to-asses-the-value-of-a-unit-test)
- [Unit Testing Principles (olano.dev)](https://olano.dev/blog/unit-testing-principles)
- [Software Engineering at Google, Ch.12 Unit Testing](https://abseil.io/resources/swe-book/html/ch12.html)
- [Google Testing Blog: Test Behavior, Not Implementation](https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html)
- [Google Testing Blog: Hermetic Servers](https://testing.googleblog.com/2012/10/hermetic-servers.html)
- [Google Testing Blog 2017/04（flaky 率）](https://testing.googleblog.com/2017/04/)
- [Fuchsia testing best practices](https://fuchsia.googlesource.com/fuchsia/+show/e669633b7e3f70baf97732fccdfa43f4de4ce64d/docs/contribute/testing/best-practices.md)
- [Testing Library: Guiding Principles](https://testing-library.com/docs/guiding-principles)
- [Testing Library: Query priority](https://testing-library.com/docs/queries/about#priority)
- [The Testing Trophy and Testing Classifications (Kent C. Dodds)](https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications)
- [Frontend Testing Strategy (techinterview.org)](https://www.techinterview.org/post/3233475065/frontend-testing-strategy-unit-integration-e2e/)
- [Frontend Testing 2026 (techinterview.org)](https://www.techinterview.org/post/3233475391/frontend-testing-2026-vitest-playwright-visual-regression/?format=md)
- [6 best practices for frontend component testing (MagicPod)](https://blog.magicpod.com/6-best-practices-for-rock-solid-frontend-component-testing)
- [Managed vs. Unmanaged Dependencies (Khalil Stemmler)](https://khalilstemmler.com/wiki/managed-vs-unmanaged-dependencies/)
- [Unit Testing PPP ch.9 (Manning)](https://livebook.manning.com/book/unit-testing/chapter-9)
- [Integration tests with Testcontainers (Zalando)](https://engineering.zalando.com/posts/2021/02/integration-tests-with-testcontainers.html)
- [A practical guide to automated testing in backend systems (HackerNoon)](https://hackernoon.com/a-practical-guide-to-automated-testing-in-backend-systems)
- [サバンナ便り（gihyo.jp）](https://gihyo.jp/dev/serial/01/savanna-letter/0008?summary)
- [自動テスト資料 (Speaker Deck)](https://speakerdeck.com/mnuma/automated-testing)
- [The Ugly Mirror (Test Smell Catalog)](https://test-smell-catalog.readthedocs.io/en/latest/Code%20related/In%20association%20with%20production%20code/The%20Ugly%20Mirror.html)
- [The Curious Case of Tautological TDD (J. B. Rainsberger)](https://blog.thecodewhisperer.com/permalink/the-curious-case-of-tautological-tdd)
- [Unit Testing Chapter 1 Excerpt (Khorikov)](https://enterprisecraftsmanship.com/files/Unit-Testing-Chapter-1-Excerpt.pdf)
