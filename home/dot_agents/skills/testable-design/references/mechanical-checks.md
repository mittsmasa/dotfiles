# 機械チェック

JS / TS のプロジェクトで、この skill の観点のうち構文から拾えるものを、ツールで先に洗い出すための手順。ツールは `~/.agents/skills/testable-design/tools/` にある。

ツールの役目は、読む範囲を狭めること。判定はしない。

| 担当 | やること | 性質 |
|---|---|---|
| L1: Oxlint のルール | 1 ファイルの構文で決まる症状を報告する | 決定的 |
| L2: `testable-scan` | プロジェクト全体から、ファイルをまたぐ候補を絞る。白黒は付けない | 決定的 |
| エージェント | 報告と候補のファイルだけを読み、SKILL.md の観点で判定する | 読んで判断する |

報告も候補も、指摘の根拠にはならない。SKILL.md の「レビューするとき」のとおり、指摘には当たる観点と、壊れる具体シナリオを添える。プロジェクトの規約がこの skill と食い違うときは、規約に従う。

## 前提

- `oxlint` が `PATH` にある（`command -v oxlint`）
- Node が 22.20.0 以降か、24.8.0 以降（`node -v`）

どちらかが欠けていたら、ツールは実行しない。機械チェックを省いたことを報告に一文で書き、SKILL.md の観点だけで進める。

npm の依存は要らない。`tools/node_modules` は、ツール自身のテストと型チェックにだけ使う。

## L1: Oxlint のルール

プロジェクトの設定とは別の設定ファイルで実行する。プロジェクトの lint 設定は読まれず、変更もしない。

```bash
oxlint -c ~/.agents/skills/testable-design/tools/oxlintrc.json <path>...
```

`<path>` に `..` は使えない。プロジェクトの中から相対パスで渡すか、絶対パスで渡す。機械で読むときは `-f json` を付ける。重さはすべて `warn` なので、報告があっても終了コードは 0 になる。

| ルール | 報告するもの | SKILL.md の対応する記述 |
|---|---|---|
| `testable/max-module-mocks` | 1 ファイルの `vi.mock` / `vi.doMock` が 3 個以上 | モックが三つ以上要るなら、実装の分け方を見直す |
| `testable/no-internal-module-mock` | 相対パスか `@/` で始まるモジュールへの `vi.mock` | モックは管理外の依存とネットワーク層に限る |
| `testable/max-effects-in-component` | コンポーネント本体の `useEffect` / `useLayoutEffect` が 3 個以上 | 副作用はカスタムフックに閉じ込める |
| `testable/no-fetch-in-component` | コンポーネントの中の `fetch(` | API 呼び出しは API クライアントに集める |
| `testable/no-ambient-nondeterminism` | コンポーネントとフックの中の `Date.now()`、引数なしの `new Date()`、`Math.random()`、`crypto.randomUUID()`、`localStorage`、`sessionStorage` | 非決定的な依存は外から渡す |

読み方の注意。

- 型情報は使っていない。コンポーネントは「名前が大文字で始まり JSX を含む関数」、フックは「名前が `use` で始まる関数」として見分けている
- `no-ambient-nondeterminism` は、副作用を置くための専用の層（ストレージを包むフック、現在時刻を配る Provider）にも報告を出す。その層の報告は、症状ではない
- `no-internal-module-mock` は specifier の文字列だけを見る。モックの対象が実在するかは L2 で分かる
- `tools/` には `testable/no-call-only-assertions`（`expect` が呼び出しの検証だけのテスト）もあるが、既定では無効にしている。コールバックや画面遷移の検証まで報告し、誤検知が多いため

## L2: `testable-scan`

```bash
node ~/.agents/skills/testable-design/tools/bin/testable-scan.ts <root> [paths...] --out <dir> [--exclude <glob>]...
```

| 引数 | 意味 |
|---|---|
| `<root>` | プロジェクトの基準ディレクトリ。`tsconfig.json` と `package.json` をここから探し、出力のパスもここからの相対で書く |
| `[paths...]` | 調べる対象。`<root>` からの相対。省略すると `<root>` 全体 |
| `--out <dir>` | 出力先。`ir.json` と `candidates.json` を書く。リポジトリに残さない場所（`$TMPDIR` か、gitignore された作業ディレクトリ）にする |
| `--exclude <glob>` | 一致するファイルを候補から除く。何度でも書ける。glob は `<root>` からの相対パスに当てる。シェルに展開させないよう引用符で囲む |

モノレポでは、`<root>` をワークスペースのルートにする。パッケージごとの `tsconfig.json` の `paths` と、workspace パッケージの `exports` を読んで import を解決する。

標準出力には、ファイル数、import の解決結果の内訳、チェックごとの候補数が出る。

### `candidates.json` の読み方

4 つのチェックの結果が入る。C3 は数えた事実、C1・C2・C4 は候補。import していることしか見えていないので、何を検証しているかは読んで確かめる。

| キー | 中身 | 読んだあとに確かめること |
|---|---|---|
| `c1` | 関数を export していて、React も JSX もフックも使わないファイルのうち、どのテストからも直接 import されていないもの。`reach` は、story からたどって届く（`story`）、テストから別のモジュール経由でだけ届く（`test`）、どちらからも届かない（`none`） | 入力と出力が決まる処理か。DB、HTTP、ファイル、環境変数に触れるコードも入るので、副作用の有無を読んで見分ける。副作用が混ざっていれば、切り出しの候補として扱う |
| `c2` | コンポーネントのうち、テストファイルと、`play` を持つ story の両方が直接 import しているもの | 同じ振る舞いを二つの層で確かめているか。Provider や枠として使っているだけなら、重複ではない |
| `c3` | `vi.mock` されている自前のモジュールと、モックしているテストファイルの一覧。多い順 | 多くのテストからモックされるモジュールは、境界の置き方を見直す候補 |
| `c4` | コンポーネントのうち、どの story からもたどって届かないもの。Next.js のルートファイル（`page.tsx`、`layout.tsx` など）は除く | 見た目の回帰を守るものがあるか。story を持たない方針の層（画面単位のつなぎ込みなど）かどうかは、プロジェクトの規約で決める |

候補が多いときは、今回の変更に関係するファイルに絞って読む。依頼の範囲外で見つけた崩れは直さず、報告に一文で書く。

### `--exclude` に渡すもの

テストや story のための資産と、開発用の部品。置き場所で決まるものを渡す。

```bash
--exclude '**/mocks/**' --exclude '**/.storybook/**' --exclude '**/stories/**'
```

除いたファイルも import グラフには残る。story が `mocks/` のデータ生成を経由して届くモジュールは、除外しても届いた扱いのままになる。除いた件数は、標準出力の `excluded:` の行に出る。

置き場所で決まらないもの（副作用を持つかどうか）は、除外では扱えない。読んで判定する。

### `ir.json`

候補のもとになった中間表現。ふだんは読まなくてよい。候補の理由を確かめたいときに、`jq` で引く。

- `files[]`: 1 ファイル 1 レコード。`kind`（`test` / `story` / `source`）、`imports`、`exports`、`jsx`、`importsReact`、`hookCalls`、`plays`
- `files[].imports[]`: `source`（書かれた specifier）、`target`（解決先のファイル）、`resolution`、`via`（`import` / `reexport` / `dynamic` / `mock`）。名前つき import は、barrel を越えて、その名前を定義しているファイルを `target` に持つ
- `stats.imports`: 解決結果の内訳

`resolution` の意味。

| 値 | 意味 |
|---|---|
| `internal` | プロジェクトのコードに解決できた |
| `generated` | 生成物のディレクトリを指していて、ファイルがディスクに無い。codegen を流していない checkout で出る |
| `external` | Node の組み込みか、`package.json` に載っているパッケージ |
| `asset` | 画像、CSS など、コードでないファイル |
| `unresolved` | どれでもない。壊れた import か、実行時に用意されるモジュール |

`via` が `mock` で `resolution` が `unresolved` のレコードは、実在しないモジュールへの `vi.mock` を指す。そのモックは効いていない可能性がある。

```bash
jq -r '.files[] | .file as $f | .imports[] | select(.via == "mock" and .resolution == "unresolved") | "\($f)\t\(.source)"' <dir>/ir.json
```

## 限界

- 型情報を使わない。コンポーネントとフックは、構文と命名で見分けている
- 「import している」は「検証している」を意味しない
- 見逃しの数は測っていない。候補に出なかったことは、問題が無いことの根拠にならない
- 解決するのは、相対パス、最も近い `tsconfig.json` の `paths`、workspace パッケージの `exports`。`package.json` の `imports`、tsconfig の `extends` と `baseUrl` は扱わない
- Oxlint の JS plugin が読めるファイルだけが対象。`.mdx` や `.vue` からの import は見えない。MDX からだけ使われるコンポーネントは、C4 に出る
- 生成物のディレクトリ名（`styled-system`、`__generated__`、`generated` など）は、`tools/facts.oxlintrc.json` の `ignorePatterns` で決めている。プロジェクトの生成物が別の名前なら、そのファイルも調べる対象に入る
- Oxlint の JS plugin は alpha で、ツールは oxlint 1.89.0 で確かめている

## ツールを直すとき

`tools/` で `pnpm install` のあと、`pnpm test` と `pnpm run typecheck` を流す。ソースは `.ts` で、ビルドせずに実行する。Node が型注釈を取り除いて実行するので、`enum` など実行時のコードを生む構文は使えない。相対 import には拡張子 `.ts` を付ける。
