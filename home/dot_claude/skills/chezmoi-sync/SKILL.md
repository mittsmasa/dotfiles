---
name: chezmoi-sync
description: "chezmoi で管理されたドットファイルの同期確認・差分解決・マージを行う。'chezmoi' 'dotfiles' 'ドットファイル' '同期' '設定ファイルの差分' などのキーワード、または chezmoi 関連の操作をユーザーが依頼した際にトリガー。"
---

# chezmoi-sync

chezmoi 管理ファイルの同期確認・差分解決ワークフロー。

## Workflow

### 1. Status Check

```bash
chezmoi status
```

出力が空なら「差分なし、同期済み」と報告して終了。

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
