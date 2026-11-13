# pr-review-inbox

自分にレビュー依頼が来ている PR を 1 時間ごとに集め、読み取り専用の subagent に下読みさせて、結果を pane に並べる mod です。

- 取得するのは平日 8〜17 時だけです（タイムゾーンは設定メニューの `utcOffsetMinutes`）
- `/review-inbox` で pane を開きます

## 必要なもの

- `gh`（ログイン済み）と `git`
- 下読みする PR のリポジトリの clone（clone が無い PR は「clone なし」と表示されます）
- 既定の機械チェックと観点を使う場合だけ、`mise`（oxlint と node）と `~/.agents/skills/testable-design`。無ければ機械チェックは省かれ、観点は汎用の指示になります

## 設定ファイル

`~/.config/pr-review-inbox/config.json` に書きます。`sources` か `repos` のどちらも無いと、何も取得しません。

### team で使う最小の例

org 内の依頼をすべて拾い、clone は `~/work/repo/<リポジトリ名>` にある前提です。

```json
{
  "sources": ["dwango-zane"],
  "clonePath": "~/work/repo/{repo}"
}
```

### キー

| キー | 意味 | 書かなかったとき |
|---|---|---|
| `sources` | 検索対象の配列。`owner` なら org 全体、`owner/repo` ならそのリポジトリ | `repos` のキー |
| `clonePath` | clone の場所。`{owner}` と `{repo}` を差し込みます。`{repo}` は必須です | `repos` に無いリポジトリは「clone なし」 |
| `repos` | `owner/repo` ごとの clone の場所。`clonePath` より優先します | なし |
| `criteria` | リポジトリごとのレビュー基準ファイル（clone 内のパス）と、対象にする変更パスの正規表現 | なし |
| `review` | 下読みの中身（次の節） | testable-design の構成 |

`criteria` の例です。

```json
"criteria": {
  "dwango-zane/heimdall": { "path": ".agents/skills/review-frontend/criteria/frontend.md", "applies": "^frontend/" }
}
```

### review: 下読みの中身を差し替える

| キー | 意味 | 書かなかったとき |
|---|---|---|
| `viewpoints` | reviewer に読ませる観点ファイルの配列（読む順）。ファイルだけで、ディレクトリは無視されます | testable-design の 4 ファイル |
| `guide` | 観点ファイルの使い方と、観点由来の指摘の書き方を書いたファイル。中身が prompt に入ります | `viewpoints` も無ければ testable-design 用の指示、あれば汎用の短い指示 |
| `commentStyle` | コメント下書きの口調を書いたファイル。中身が prompt に入ります | 相談形の口調（「〜はどうでしょうか」） |
| `checks` | 機械チェックの配列。`[]` にすると機械チェックをしません | oxlint と testable-scan |

`checks` の各項目は次の形です。

```json
{ "name": "oxlint", "argv": ["oxlint", "-c", "~/lint/oxlintrc.json", "-f", "json", "{files}"], "stdout": "oxlint.json" }
```

- `argv` は shell を通さずに実行します。`argv[0]` は絶対パスか、PATH 上のコマンド名です
- 置き換わる値:
  - `{files}`: 変更された JS / TS ファイルの絶対パス（1 ファイル 1 引数）
  - `{relativeFiles}`: 同じファイルの worktree からの相対パス。`./` から始まります
  - `{worktree}`: PR の checkout
  - `{outDir}`: 出力先のディレクトリ
- `stdout` を書くと、標準出力を `{outDir}/<stdout>` に保存します
- `outputs` には、コマンドが自分で `{outDir}` に書くファイル名を並べます。終わったときにこれが無ければ、そのチェックは失敗扱いです
- 終了コードは見ません。lint は指摘があると 0 以外で終わるためです。起動できない、タイムアウト（3 分）、`outputs` が無い、のどれかで失敗になり、pane の「省いたもの」に出ます

設定の誤り（読めない項目）は既定値に倒し、取得のあとに pane へ「取得に失敗しました: 設定の誤り: …」と出ます。取得そのものは成功しています。

## reviewer が触れるもの

reviewer は Read / Grep / Glob と、結果ファイル 1 つへの Write だけを使えます。読めるのは次の範囲に限られます。

- PR の checkout
- diff と機械チェックの出力
- `criteria` のファイル（clone 内にある場合だけ）
- `viewpoints` のファイル
