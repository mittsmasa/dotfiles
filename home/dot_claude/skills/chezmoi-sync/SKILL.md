---
name: chezmoi-sync
description: "chezmoi で管理されたドットファイルの同期確認・差分解決・マージを行う。'chezmoi' 'dotfiles' 'ドットファイル' '同期' '設定ファイルの差分' などのキーワード、または chezmoi 関連の操作をユーザーが依頼した際にトリガー。"
---

# chezmoi-sync

chezmoi 管理ファイルの同期確認・差分解決ワークフロー。

## Workflow

### 0. Remote Pull (必須・省略不可)

**必ず最初にリモートから最新を取り込む。** ローカルだけ見て「同期済み」と判断してはならない。

```bash
chezmoi git -- pull --rebase
```

- 失敗した場合（conflict 等）はユーザーに状況を報告して指示を仰ぐ
- pull で更新があった場合は `chezmoi status` に差分が出るので、以降のステップで通常通り処理する

### 1. Status Check

```bash
chezmoi status
```

出力が空でも**油断しない**。`chezmoi status` は**既に管理下にあるファイルの差分しか報告しない**。
新規ファイル（まだ `chezmoi add` されていないもの）は status に現れないため、次の Step 1.5 で別途確認する。

### 1.5 Untracked File Detection (新規ファイルの検出)

以下のいずれかに該当する場合、**必ずこのステップを実行する**:

- ユーザーが「今回作ったもの」「新しく追加したファイル」系の依頼をしている
- 直近の会話で chezmoi 管理下のディレクトリ（`~/.claude/`, `~/.config/`, `~/.zshrc` 周辺など）に **新規ファイルを作成した** 覚えがある
- ユーザーが特定のファイル／ディレクトリを指定して同期を依頼している

**確認方法**:

```bash
# 個別確認（管理下なら exit 0、未追跡なら非 0）
chezmoi source-path <file> &>/dev/null && echo "managed" || echo "untracked"

# パターン一致で一覧から探す
chezmoi managed | grep -E '<pattern>'
```

未追跡ファイルが見つかったら `chezmoi add` で追加する:

```bash
chezmoi add ~/.claude/scripts/new-script.sh ~/.claude/skills/new-skill/SKILL.md
```

- 実行権限があれば `executable_` prefix が自動付与され、権限が保持される
- `autoCommit`/`autoPush` が有効な環境では `chezmoi add` 実行時にそのまま commit → push まで走る
- 追加後、再度 `chezmoi status` が空であることを確認する

### 2. Diff Review

差分がある場合:

```bash
chezmoi diff
```

差分の要約テーブルを提示（何が追加/削除/変更されたか）。

### 3. Merge Analysis

ソースファイルと実ファイルの両方を読み、差分を分析:

```bash
chezmoi source-path ~/.<target>   # ソースパスを取得
```

- ソースファイル（chezmoi 管理側）を Read
- 実ファイル（ホームディレクトリ側）を Read

変更を分類して提示:
- **ソースのみ**: chezmoi ソースにあるが実ファイルにない変更
- **実ファイルのみ**: 実ファイルにあるがソースにない変更
- **競合**: 同じ箇所に異なる変更（例: 同じ機能の別実装）

### 4. Conflict Resolution

競合がある場合はユーザーに選択を求める。競合しない変更はそのまま両方採用。

### 5. Apply

マージ方針が決まったら:

- **ソース側が正**: `chezmoi apply <file>` で実ファイルを更新
- **実ファイル側が正**: `chezmoi add <file>` でソースを更新
- **両方マージ**: ソースファイル（`.tmpl` 等）を直接編集してから `chezmoi apply`

### 6. Verify

```bash
chezmoi status   # 空であること
```

### 7. Remote Sync Check

```bash
cd "$(chezmoi source-path)" && git status && git log --oneline -3
```

- `autoCommit`/`autoPush` が有効なら自動反映済み
- 未プッシュのコミットがあれば報告
- 設定確認: `chezmoi cat-config`

## Notes

- `.tmpl` 拡張子のファイルは chezmoi テンプレート構文（`{{ if ... }}`）を含む。編集時にテンプレート構文を壊さないこと
- `chezmoi managed --include=files` で管理対象ファイル一覧を取得可能
- **PostToolUse hook (`chezmoi-sync-hook.sh`) は既存管理下ファイルの更新のみを自動同期する**。
  hook は `chezmoi source-path <file>` の成否で判定しているため、**新規ファイルは弾かれる**。
  そのため「今回作ったものを同期して」系の依頼では `chezmoi status` が空でも安心せず、
  必ず Step 1.5 の新規ファイル検出を実行すること
- `chezmoi status` が空 = 同期済み、ではない。あくまで「既存管理下ファイルに差分がない」だけ
