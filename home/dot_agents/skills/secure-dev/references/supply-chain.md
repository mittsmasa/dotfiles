# 第三者のコードを取り込むとき

依存の追加・更新、パッケージマネージャ設定、拡張機能や「開くと動く設定」を扱うときに読む。設定キーと既定値はツールのバージョンで変わるので、書く前に使っているバージョンの公式ドキュメントで確かめる。

## 公開直後のバージョンを入れない（クールダウン）

配布元が乗っ取られると、悪意あるバージョンが正規の名前で数時間〜数日公開される。多くは発覚して取り下げられるので、公開から一定期間待てば踏む確率が下がる。

- 目安は公開から 7 日以上、できれば 7〜14 日
- 緊急のセキュリティ修正は待つほうが危ない。そのバージョンだけを例外に足し、理由（advisory の ID など）をコメントで残し、期限が来たら例外を消す
- クールダウン機能が無いツールでは、自動更新を切り、公開日時と変更内容を見てから上げる

設定例（2026-11 時点で確認）:

- pnpm: `pnpm-workspace.yaml` の `minimumReleaseAge`（単位は分。`10080` で 7 日）と `minimumReleaseAgeExclude`。pnpm は auth、registry 以外の設定を `.npmrc` から読まないので、`pnpm-workspace.yaml` に書く
- npm: `before`（指定日時以前に公開されたバージョンだけを入れる）。`min-release-age` も設定一覧にあるが、本文は未確認なので使う前に `npm help config` で確かめる
- Renovate: `minimumReleaseAge`（`"7 days"` のような期間の文字列）

確かめ方: 入ったバージョンの公開日を `npm view <pkg> time --json` で見る。

## インストール時の script を許可制にする

`preinstall`、`postinstall` などは、依存を入れただけで開発端末や CI の権限で走る。サプライチェーン攻撃の多くがここで認証情報を盗む。

- script の実行は既定で止め、ネイティブビルドなど必要なパッケージだけ許可する
- 許可リストに足すときは、その script が何をするかを読んでから足す
- ビルド時、import 時、実行時にも悪意あるコードは動く。この対策だけで安全とはみなさない

設定例:

- pnpm: `pnpm-workspace.yaml` の `allowBuilds`（パッケージ名をキーに `true` / `false`）。許可されていない script を失敗にする `strictDepBuilds` もある
- npm: `ignore-scripts=true`。必要なパッケージだけ `npm rebuild <pkg>` で個別に動かす

## 依存を不変な参照で固定する

タグやバージョン範囲は、同じ名前のまま中身を差し替えられる。中身で指せば、意図しない更新を防げて、インシデント時に「何が入っていたか」を正確に追える。

- lockfile をコミットする。CI では lockfile を書き換えないモードで入れる（`pnpm install --frozen-lockfile`、`npm ci`）
- GitHub Actions は 40 文字の commit SHA で指し、横にバージョンをコメントで残す。SHA が fork でなく本家のものか確かめる
- コンテナイメージは `image@sha256:...` の digest で指す
- Renovate などで SHA、digest の更新 PR を自動で作れば、固定と更新を両立できる

## 拡張機能と「開くと動く設定」

IDE、エディタ、ブラウザの拡張は、開発者本人の権限でソースコードや認証情報に触れる。

- 拡張は第三者のコードとして扱い、入れる前に提供元、権限、更新頻度を見る
- 次の設定は、リポジトリを開くかツールを動かすだけでコードが走る。追加・変更はソースコードと同じくレビューする
  - `.vscode/tasks.json`（`runOn: folderOpen`）、`.vscode/settings.json` のツールパス
  - Git hook（`.githooks/`、husky、lefthook）
  - devcontainer の `postCreateCommand` などの初期化処理
  - AI ツールの hook、MCP 設定（詳細は `platform-and-agents.md`）

## 修正版を適用し続ける

- 使っている依存の advisory（GitHub Dependabot alerts、`pnpm audit`、`npm audit` など）を見て、影響する脆弱性に修正版が出たら上げる
- クールダウンより、既知の脆弱性を放置するリスクが大きいときは待たずに上げる（クールダウンの例外の手順に従う）
- 修正版が無い、すぐ上げられないときは、advisory に書かれた緩和策に従う
- サポートが切れたバージョンは、問題なく動いていても修正が来ない。移行先を提案する
