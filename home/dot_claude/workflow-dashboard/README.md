# workflow-dashboard

workflow.md の成果物（research / plan / verify-results）を GitHub Projects 風カンバンで見るローカル Web アプリ。

## 起動

### portless 経由（おすすめ・ポートなし）

```sh
~/.claude/workflow-dashboard/portless-start.sh
```

→ `https://workflow.localhost` で開く。proxy は systemd で常駐済みなので、アプリ本体だけ起動すればよい。

### 素のローカル（ポート直指定）

```sh
bash ~/.claude/workflow-dashboard/start.sh
```

→ `http://localhost:4519`

## データ

`~/.claude/workflow/{YYYY-MM-DD}-{slug}/` 配下の `.md` 成果物を走査して表示する。
このデータ自体は chezmoi 非同期（実データのため）。

## 別マシンでのセットアップ

1. `chezmoi apply` でアプリのソースを展開
2. `cd ~/.claude/workflow-dashboard && bun install` で依存（portless 等）を再取得
3. `bunx portless service install` で HTTPS proxy を systemd 常駐サービス化
4. ブラウザの証明書ストアに portless の local CA を信頼追加
   （WSL + Windows ブラウザなら Windows 側の証明書ストアへ）
