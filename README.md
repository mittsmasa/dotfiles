# dotfiles

My dotfiles managed with [chezmoi](https://www.chezmoi.io/).

## Setup (新しいマシン)

### Prerequisites
- macOS
- [Homebrew](https://brew.sh/)

### Install
```bash
brew install chezmoi
chezmoi init --apply mittsmasa/dotfiles
```

### Post-install
Create `~/.zshrc.local` for machine-specific secrets:
```bash
export ANTHROPIC_AUTH_TOKEN="your-token"
```

## 日常の更新ワークフロー

### 設定ファイルを変更したい場合

**方法A: chezmoi edit（推奨）**
```bash
# chezmoi のソースを直接編集 → 差分確認 → 適用
chezmoi edit ~/.zshrc
chezmoi diff
chezmoi apply
```

**方法B: ホームの設定を変更してから取り込み**
```bash
# ホームのファイルを直接編集した後、chezmoi に取り込む
vim ~/.config/ghostty/config
chezmoi re-add ~/.config/ghostty/config
```

### リモートの変更を取得
```bash
# リモートの最新を取得して適用
chezmoi update
```

### 変更をコミット・プッシュ
```bash
cd ~/work/repo/dotfiles
git add -A
git commit -m "Update: 変更内容"
git push
```

### 便利コマンド一覧
| コマンド | 説明 |
|---------|------|
| `chezmoi diff` | ソースとホームの差分を確認 |
| `chezmoi apply` | ソースの設定をホームに適用 |
| `chezmoi edit <file>` | ソース側のファイルを編集 |
| `chezmoi re-add <file>` | ホーム側の変更をソースに取り込み |
| `chezmoi update` | リモートから最新を取得して適用 |
| `chezmoi managed` | 管理対象ファイル一覧 |
| `chezmoi unmanaged` | 未管理ファイル一覧 |
