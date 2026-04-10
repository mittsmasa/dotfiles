---
name: fresh
description: |
  fresh ターミナルエディタの操作スキル。ディレクトリ単位の session に
  ファイルを投げ込んだり、新しいペインで fresh を起動したり、
  `file:line:col@"msg"` 記法でユーザーにピンポイントで場所を示したりする。

  トリガー: 「ここ見て」「fresh で開いて」「エディタで開いて」
  「ユーザーに見せる」「この行を確認してもらう」「レビューしてもらう」
  「セッションにファイル追加」
---

# fresh 操作スキル

fresh は multi-cursor 対応のターミナルエディタ。Bash ツールで fresh コマンドを
実行して、ファイルを開く・既存セッションに投げ込む・場所指定で示す、などを行う。

## 前提確認

操作前に必ず実行:

```bash
fresh --version                          # 導入確認
fresh --cmd session list                 # 既存セッション一覧
```

セッションはディレクトリ単位で永続化されている。既存セッションがあれば、
新規起動せずそこへファイルを投げ込むのが望ましい（ユーザーの作業状態を壊さない）。

## コア操作

```bash
# ファイルを開く（新規起動）
fresh path/to/file.txt

# 行・列・範囲・popup 付きで開く
fresh 'file.txt:10'                      # 10 行目
fresh 'file.txt:10:5'                    # 10 行 5 列
fresh 'file.txt:10-20'                   # 10〜20 行を選択
fresh 'file.txt:10@"ここを見てください"'  # popup メッセージ付き

# セッション操作
fresh --cmd session list                 # 一覧
fresh --cmd session new <name>           # 新規セッション作成
fresh --cmd session attach <name>        # アタッチ（-a <name> でも可）
fresh --cmd session kill <name>          # 終了

# 既存セッションにファイルを開く（最重要）
fresh --cmd session open-file <name> <files...>
fresh --cmd session open-file <name> <files...> --wait   # 開き終わるまで待つ
```

**場所指定記法は必ずシングルクォートで囲う**:
`file.txt:10@"msg"` の `"` や `@` がシェルに解釈されないようにするため。

## 意思決定フロー

ファイルを開く前に、必ずこの順で判断する:

1. **既存セッションはあるか** → `fresh --cmd session list`
2. **あれば**: `fresh --cmd session open-file <name> <files>` で投げ込む
3. **なければ**:
   - tmux / cmux 内 → 新ペインを split して `fresh <files>` を起動
   - multiplexer 外 → ユーザーに確認してから `fresh <files>` を起動（現在の作業を覆う可能性があるため）

## ワークフロー例

### 既存セッションに「ここ見て」で投げ込む

```bash
# 1. セッション名を取得（通常はディレクトリ名）
fresh --cmd session list

# 2. popup メッセージ付きで開く
fresh --cmd session open-file myproj 'src/foo.ts:42@"この分岐が怪しいです"'
```

### tmux 新ペインで fresh を起動

```bash
tmux split-window -h -c "$(pwd)"
tmux send-keys -t '{next}' "fresh 'src/foo.ts:42:5'" C-m
```

### cmux 新ペインで fresh を起動

```bash
cmux new-split right
# surface 番号を確認してから送信
cmux list-pane-surfaces
cmux send --surface surface:N "fresh 'src/foo.ts:42:5'\n"
```

### 複数ファイル + 範囲選択でレビュー依頼

```bash
fresh --cmd session open-file myproj \
  'src/foo.ts:10-30@"ここのロジックをレビューしてください"' \
  'src/bar.ts:55@"関連する呼び出し元"'
```

## 注意事項

- `fresh --cmd session open-file` はユーザーの既存作業を壊さないので、レビュー用途では最優先
- 場所指定記法は**必ずシングルクォート**で囲う
- 新ペインで起動するときは、起動後 `fresh --cmd session list` で新セッションが立ち上がったことを確認してもよい
- `--wait` を付けるとスクリプト的に使える（ユーザーが閉じるまでブロック）
- multiplexer 外で `fresh <files>` を実行すると現在のターミナル画面を覆う。確認してから実行する
