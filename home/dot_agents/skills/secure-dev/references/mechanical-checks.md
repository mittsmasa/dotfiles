# 機械チェック

secure-dev の確認項目のうち、ファイルの中身から拾えるものを、ツールで先に洗い出すための手順。ツールは `~/.agents/skills/secure-dev/tools/` にある。

ツールの役目は、読む範囲を狭めること。判定はしない。

| 担当 | やること | 性質 |
|---|---|---|
| zizmor | GitHub Actions の workflow、`action.yml`、dependabot 設定を監査する | 決定的 |
| gitleaks | 作業ツリーに秘匿情報が書かれていないかを探す | 決定的 |
| `secure-scan` の自作ルール | 上の二つが見ない項目（パッケージマネージャ設定、lockfile、Dockerfile、k8s・compose、workflow の env の範囲、AI エージェントの設定）を行単位で拾う | 決定的 |
| エージェント | `findings.json` の行の周辺だけを読み、SKILL.md の観点で要対応かを判定する | 読んで判断する |

結果は指摘の根拠にならない。SKILL.md の「報告の書き方」のとおり、侵入経路と被害、直し方を添える。

## 前提

- Node 24 以降（`.ts` を type stripping で直接動かす）。npm の依存は無い
- zizmor と gitleaks は任意。PATH に無ければその層を省き、`findings.json` の `skipped` に理由を残す

## 使い方

```bash
node ~/.agents/skills/secure-dev/tools/bin/secure-scan.ts <root> [paths...] --out <dir>
```

| 引数 | 意味 |
|---|---|
| `<root>` | 基準ディレクトリ。出力のパスはここからの相対。lockfile の探索もここで止まる |
| `[paths...]` | 調べる対象（`<root>` からの相対）。省略すると `<root>` 全体。gitleaks もこの範囲に当てる |
| `--out <dir>` | `findings.json` を書く場所 |

`node_modules`、`.git`、`dist`、`build`、`.next`、`coverage`、`vendor`、`.workflow`、`.claude/worktrees`、`.worktrees` は除外する。1 MB を超えるファイルは読まない。

全体の走査は数秒かかる（gitleaks が大半）。変更に関係するパスがはっきりしていれば `[paths...]` に渡す。ただし lockfile やクールダウンの設定はリポジトリのルート近くにあるので、依存を触る作業では `<root>` 全体を見る。

zizmor と gitleaks は、走査先の設定で検出を止められないように動かす。

- zizmor: `--offline --no-config --no-ignores`。オンラインの audit（impostor-commit、known-vulnerable-actions など）は走らせない
- gitleaks: 既定ルールを継承するだけの `tools/gitleaks.toml` を `--config` で渡す。`.gitleaksignore` は空のディレクトリに向け、`gitleaks:allow` を無視し、`GITLEAKS_CONFIG*` 環境変数を外す。`--redact` を付け、正規化では値の欄（`Match`、`Secret`、`Line`）を捨てる

## `findings.json` の読み方

```json
{
  "ran": ["secure-scan", "zizmor", "gitleaks"],
  "skipped": [{ "tool": "zizmor", "reason": "PATH に zizmor が無い" }],
  "counts": { "zizmor:artipacked": 3, "secure-scan:docker/unpinned-base": 2 },
  "findings": [{ "source": "secure-scan", "rule": "docker/unpinned-base", "kind": "symptom", "file": "Dockerfile", "line": 1, "message": "..." }],
  "inventory": [{ "kind": "mcp", "path": ".mcp.json" }]
}
```

- `kind: symptom`: その行だけで問題と分かるもの。行の前後を読み、例外的に許される事情（コメントで理由が書かれている、など）が無いかだけを確かめる
- `kind: candidate`: 読まないと判断できないもの。周辺と、指している先（許可したパッケージの script など）を読む
- zizmor と gitleaks の結果は `severity` を持つ。zizmor の各 audit の説明は `https://docs.zizmor.sh/audits/#<rule>`
- `inventory`: 変更したらレビューが要るファイルの一覧。指摘ではない。今回の変更がこの一覧のファイルに触れていたら、SKILL.md の「AI エージェントを使うとき」の最後の項目と `supply-chain.md` の「開くと動く設定」を当てる

既存の問題と、今回の変更で入った問題は分けて報告する。`git diff --name-only` に含まれるファイルの結果を先に見る。

## 自作ルール

| id | 種類 | 拾うもの | SKILL.md の確認項目 |
|---|---|---|---|
| `cooldown/pnpm-missing` | symptom | `pnpm-workspace.yaml` に `minimumReleaseAge` が無い（既定は 1440 分）、または 10080 分未満 | 公開から 7 日以上 |
| `cooldown/pnpm-exclude` | candidate | `minimumReleaseAgeExclude`（ブロックごとに 1 件にまとめる） | 例外の理由と期限 |
| `cooldown/renovate-missing` | symptom | renovate の設定に `minimumReleaseAge`（`stabilityDays`）が無い、または 7 日未満 | 公開から 7 日以上 |
| `npmrc/pnpm-ignored-key` | symptom | pnpm プロジェクトの `.npmrc` にある、auth・registry・TLS・proxy・`local-address` 以外のキー | 設定の置き場所 |
| `scripts/allow-all` | symptom | `dangerouslyAllowAllBuilds: true`、`strictDepBuilds: false` | install script を許可制にする |
| `scripts/allowed` | candidate | `allowBuilds` で `true` の項目。v11 で削除された `onlyBuiltDependencies` などのキー | 許可するパッケージの確認 |
| `scripts/npm-not-ignored` | symptom | `package-lock.json` の隣の `.npmrc` に `ignore-scripts=true` が無い | install script を許可制にする |
| `lockfile/missing` | symptom | 依存のある `package.json` から `<root>` まで遡って lockfile が無い | lockfile をコミットする |
| `lockfile/not-frozen` | symptom | Dockerfile の `pnpm install`（`--frozen-lockfile` 無し）、`yarn install`（`--frozen-lockfile` / `--immutable` 無し）、Dockerfile と workflow の `npm install` | lockfile を書き換えないモード |
| `docker/unpinned-base` | symptom | `FROM` に `@sha256:` が無い（`scratch` と前段の stage 名は除く） | digest で指す |
| `docker/root-user` | symptom | 最終 stage に `USER` が無い、または最後の `USER` が root / 0 | 非 root で動かす |
| `docker/remote-add` | symptom | `ADD https://...` | 第三者のコード |
| `shell/pipe-to-shell` | symptom | `curl` / `wget` の出力を `sh` / `bash` に渡す（Dockerfile、workflow、シェルスクリプト） | 第三者のコード |
| `container/host-access` | symptom | `.github/` 外の YAML の `privileged: true`、`hostNetwork` / `hostPID` / `hostIPC`、`hostPath`、`docker.sock`、`allowPrivilegeEscalation: true`、`runAsUser: 0`、compose の `network_mode: host` / `pid: host` / `user: root` | ホストから離す |
| `ci/secrets-wide-env` | candidate | workflow / job レベルの `env:` で `secrets.` を参照（step、`services`、`container` の `env:` は除く） | 秘匿情報を必要な step にだけ渡す |
| `agent/unpinned-mcp` | symptom | MCP 設定の `npx` / `bunx` / `pnpx` / `uvx` で、パッケージにバージョン指定が無い | 第三者のコード |
| `agent/broad-permission` | symptom | Claude Code の `bypassPermissions` と `Bash` の全許可、Codex の `approval_policy = "never"` / `sandbox_mode = "danger-full-access"`、`--dangerously-skip-permissions` などのフラグ | 不可逆な操作の統制 |
| `open-on-run/auto-run` | candidate | `.vscode/tasks.json` の `folderOpen`、devcontainer の `initializeCommand` / `postCreateCommand` など | 開くと動く設定 |

### 読み方の注意

- YAML と JSON5 はパースせず、行と字下げで見ている。複数行の文字列やアンカー、フロー形式（`{ a: b }`）は取りこぼす。見つからないことは、無いことの証明にならない
- `cooldown/pnpm-missing` は、`pnpm-workspace.yaml` があるのに pnpm 以外で入れている場合にも出る。lockfile の種類を見て判断する
- `lockfile/not-frozen`: workflow の `pnpm install` は対象外にしている。pnpm は CI 環境では lockfile があれば既定で frozen になるため。yarn berry も CI では既定で immutable。Dockerfile は CI 環境変数が無いので対象にする
- `lockfile/missing`: アプリケーションでないライブラリは lockfile をコミットしない方針もある。公開パッケージかどうかを見る
- `docker/unpinned-base`: `ARG` で組み立てたイメージ名も報告する。digest を `ARG` の既定値に入れているなら、その行を確かめる
- `docker/root-user`: ベースイメージの既定ユーザーが非 root（distroless の `nonroot` タグなど）なら問題ない。nginx などは root で起動して worker を落とす作りもあるので、イメージの既定を確かめる
- `ci/secrets-wide-env`: 全 step が使う値（プライベートレジストリの読み取りトークンなど）もある。どの step が使うかを見て、step の `env:` に寄せられるかを判断する
- `agent/unpinned-mcp`: npm のタグ（`@latest`）もバージョン付きとして扱う。`@latest` は固定にならないので、見つけたら別に指摘する
- `inventory` の skill はディレクトリ単位にまとめている

## 外部ツールが受け持つ確認項目

自作ルールは、ここに挙げたものを重ねて拾わない。

| 確認項目 | zizmor の audit |
|---|---|
| GitHub Actions を SHA で指す、イメージを digest で指す | `unpinned-uses`、`unpinned-images` |
| `pull_request_target`、`workflow_run` の扱い | `dangerous-triggers` |
| `${{ }}` を `run:` に直接埋めない | `template-injection` |
| `GITHUB_TOKEN` の権限を絞る | `excessive-permissions`、`undocumented-permissions` |
| cache と artifact の使い回し、checkout の認証情報の残留 | `cache-poisoning`、`artipacked` |
| secrets の受け渡し | `secrets-inherit`、`overprovisioned-secrets`、`unredacted-secrets` |
| OIDC による公開 | `use-trusted-publishing` |
| dependabot のクールダウン | `dependabot-cooldown` |

| 確認項目 | gitleaks |
|---|---|
| 秘匿情報をコード、設定、ドキュメントに書かない | 既定ルール一式 |

## 機械では拾わないもの

次は SKILL.md の観点でエージェントが確かめる。

- 入れたバージョンが公開から 7 日たったか（`npm view <pkg> time --json`）
- 許可した install script が何をするか、MCP サーバや拡張機能の提供元
- ベースイメージやランタイムがサポート期間内か、更新が稼働環境に反映されたか
- GitHub Actions の SHA が fork でなく本家のものか（zizmor のオンライン audit `impostor-commit` の範囲）
- 変更者の検証、公開・本番更新の独立承認（リポジトリ設定、environment の required reviewers）
- 静的トークンを OIDC に置き換えられるか
- AI エージェントの 3 条件、製品に組み込んだエージェントの認可
