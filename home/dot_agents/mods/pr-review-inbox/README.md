# pr-review-inbox

自分にレビュー依頼が来ている PR を 1 時間ごとに集め、読み取り専用の subagent に下読みさせて、結果を pane に並べる mod です。

- 取得するのは平日 8〜17 時だけです（タイムゾーンは設定メニューの `utcOffsetMinutes`）
- `/review-inbox` で pane を開きます

## 必要なもの

- `gh`（ログイン済み）と `git`
- 下読みする PR のリポジトリの clone（clone が無い PR は「clone なし」と表示されます）

## 設定ファイル

`~/.config/pr-review-inbox/config.json` に書きます。`sources` か `repos` のどちらも無いと、何も取得しません。

### team で使う最小の例

org 内の依頼をすべて拾い、clone は `~/work/repo/<リポジトリ名>` にある前提です。

```json
{
  "sources": ["your-org"],
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
| `review` | 下読みの中身（次の節） | 観点ファイルなし、機械チェックなし |

`criteria` の例です。

```json
"criteria": {
  "your-org/your-repo": { "path": "docs/review-criteria.md", "applies": "^frontend/" }
}
```

### review: 下読みの中身を差し替える

| キー | 意味 | 書かなかったとき |
|---|---|---|
| `viewpoints` | reviewer に読ませる観点ファイルの配列（読む順）。ファイルのパスか glob で書きます。ディレクトリをそのまま書くと無視されます | なし。差分と `criteria` だけで下読みします |
| `guide` | 観点ファイルの使い方と、観点由来の指摘の書き方を書いたファイル。中身が prompt に入ります。観点由来の指摘の `source` は `"viewpoint"` です | 汎用の短い指示 |
| `commentStyle` | コメント下書きの口調を書いたファイル。中身が prompt に入ります | です・ます調で、問題、理由、直し方の案を 1〜3 文で書く |
| `checks` | 機械チェックの配列 | なし。機械チェックをしません |

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
- 終了コードは見ません。lint は指摘があると 0 以外で終わるためです。起動できない、タイムアウト（3 分）、`outputs` が無い、のどれかで失敗になり、pane の「確認した点」の下に「省いたもの」として出ます

設定の誤り（読めない項目）は既定値に倒し、取得のあとに pane へ「取得に失敗しました: 設定の誤り: …」と出ます。取得そのものは成功しています。

## 詳細ビュー

PR を選ぶと、上から順に次が並びます。

1. タイトルと、`GitHub で開く`、`深掘りする`、`片付ける`
2. 概要（PR の本文）。4 行以上なら 3 行に畳み、`続きを表示` と `折りたたむ` で開閉します
3. 指摘
4. 確認した点。reviewer が確かめたことの箇条書きです。確認できなかった事柄は、その下に「省いたもの」として出ます
5. PR コメント欄と送信ボタン

PR コメント欄は、承認できる PR にだけ出ます。初期値は `LGTM!` です。`承認して送る` を押すと、欄の文面を本文にした確認が出ます。欄を空にすると、本文なしで承認します。

## 深掘りと worktree

`深掘りする` は、別セッションでのレビューを頼む依頼文を作ります。入力欄に入れられないとき（デスクトップアプリ）はクリップボードにコピーするので、貼って送ります。

依頼文には次の 2 つが入ります。

- 下読みが使った worktree の場所（`<clone>/.claude/worktrees/review-<PR 番号>`）
- 下読みの結果の場所（`~/.cache/pr-review-inbox/results/<owner>/<repo>/<PR 番号>/<sha>.accepted.json`）

worktree は PR の head そのものです。中身は信頼しないでください。次の PR では、worktree の場所を依頼文に入れず、結果の場所だけを入れます。その worktree でセッションを開くと、PR が足した設定や指示が読み込まれうるためです。

- どこかの階層の `.claude/` 配下、`CLAUDE.md`、`CLAUDE.local.md`、`AGENTS.md`、`.mcp.json` を変えている PR
- 変更ファイルの一覧を全部は取得できなかった PR

worktree は下読みが終わっても残り、次のどれかで消えます。深掘りのセッションが開いていても消えます。

- `片付ける` を押す
- レビューを送る
- `もう一度レビューする` を押す、または PR に新しい commit が来て下読みし直す

一覧から消えた PR（マージ、依頼の取り下げ）の worktree は消えません。`git worktree remove <path>` で消してください。保存済みの結果を使い回した PR には worktree がありません。

## reviewer が触れるもの

reviewer は Read / Grep / Glob と、結果ファイル 1 つへの Write だけを使えます。読めるのは次の範囲に限られます。

- PR の checkout
- diff と機械チェックの出力
- `criteria` のファイル（clone 内にある場合だけ）
- `viewpoints` のファイル
