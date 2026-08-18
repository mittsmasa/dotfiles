---
name: ci-autofix
description: "PR の CI をポーリングで見張り、落ちたら原因を調べて修正・push し、green になるまで繰り返す。CI 修正だけを担当し、レビューコメントへの対応・返信・resolve は一切しない（Claude Desktop の「CIを自動修正してコメントに対応」の代替。あちらは OFF にして使う）。トリガー: 「CI 見張って」「CI 落ちたら直して」「CI が通るまで面倒見て」「/ci-autofix [PR番号|URL]」、PR 作成・push 直後に CI の完走を待ちたいとき。"
allowed-tools: Bash(gh:*) Bash(git:*)
---

# CI Autofix

PR の CI を **ポーリングで長めに見張り**、失敗したら直して push、green になるまで回すループ。
push 型（Desktop の CI モニタ）ではなく、このセッション内で `gh pr checks --watch` を回して自前で待つ。

## やること / やらないこと

| やる | やらない |
|---|---|
| CI の失敗を調べて **根本原因** を直す | レビューコメントを読む・対応する・返信する・resolve する |
| PR ブランチに commit / push（通常 push のみ） | `git push --force`、他ブランチへの push |
| flaky と判断できるものの re-run（1 回まで） | CI 設定の書き換え・テストの skip / disable による「緑化」 |
| 進捗の短い報告 | PR 本文・ラベル・アサインの変更、自動マージ |

## 前提チェック（ループ開始前に 1 回）

1. 対象 PR を決める。引数（番号 / URL）があればそれ、無ければ `gh pr view --json number,url,headRefName,headRepository` でカレントブランチの PR。見つからなければユーザーに聞く
2. `git branch --show-current` が PR の `headRefName` と一致すること。違えば **止めて報告**（別ブランチで作業中に勝手に checkout しない）
3. `git status --porcelain` に未コミット差分があれば覚えておく。修正 commit にそれを **混ぜない**（`git add` は自分が触ったファイルだけ）
4. 上限を決める: 修正ラウンド最大 **5**、同じチェックが同じ原因で 2 回連続落ちたら **止めて報告**

## ループ

```
round = 0
loop:
  1. watch   → 全 checks 完走 or 最初の失敗まで待つ
  2. 判定    → 全 pass: 完了報告して終了 / 失敗あり: 3 へ
  3. 調査    → 失敗ログを読み、flake か本物か判断
  4. 修正    → flake: 1 回だけ re-run して 1 へ / 本物: 直して commit・push、round++ して 1 へ
  上限到達 or 同一原因の再失敗 → 止めて報告
```

### 1. watch（待ち）

Bash の **`run_in_background: true`** で回す（終了時に自動で起こされる。フォアグラウンドの 10 分制限に縛られない）。

```bash
gh pr checks <PR> --watch --fail-fast --interval 30
```

- 終了コード 0: 全 pass → 完了
- 終了コード 1: 失敗あり → 3 へ
- 終了コード 8 / "no checks reported": まだ CI が始まっていない。**背景で `sleep 60` してから再実行**（フォアグラウンド `sleep` は使えない）。5 分待っても checks が出なければ「CI が起動していない」と報告して止める
- ネットワーク等の一時エラー: 60 秒後に再実行。3 回続いたら報告して止める

push 直後は前回の run が残っていて瞬時に 0 で返ることがある。**push 後の watch は、まず `gh pr checks <PR> --json name,state,bucket,startedAt` で新しい run が pending / in-progress になっているのを確認してから** `--watch` に入る。

### 3. 調査

```bash
gh pr checks <PR> --json name,state,bucket,link,workflow   # どれが落ちたか
gh run view <run-id> --log-failed                           # 失敗ジョブのログだけ
```

`run-id` は `link` の URL（`/actions/runs/<id>/job/...`）から取る。ログは長いので `--log-failed` を優先し、必要なら `gh run view <run-id> --job <job-id> --log | grep -n -E "error|FAIL|✗" ` 等で絞る。

**flake の目安**（当てはまれば re-run を先に試す。ただし 1 回だけ）:
- 落ちたテストが今回の変更ファイルと無関係、かつ timeout / network / port in use / ECONNRESET 系
- 前回 run で同じテストが pass している
- ジョブがログなしで cancelled / infra error

判断がつかなければ本物扱いで調査を続ける（re-run で誤魔化さない）。

### 4. 修正

- **原因を直す**。テストを skip / delete したり、`--no-verify` や lint disable で黙らせて緑にしない。lint disable が既存の慣習（file-level の理由付きコメント等）に沿う場合のみ可
- 直したら **ローカルで該当チェック相当を再現** してから push（`pnpm test <file>`、`pnpm lint`、`pnpm typecheck` 等、リポジトリの流儀に合わせる）
- commit は自分が触ったファイルだけ `git add`。メッセージは何の CI をなぜ直したか一行で。GPG 署名で失敗したら `source ~/.zshrc && git commit ...`
- `git push`（force しない）
- push したら 1 行報告してから watch に戻る: 「`test` が `foo.test.ts` の言語依存で落ちていたので mock を固定して push しました。再度 watch します」

## 終了時の報告

短く。

- 全 pass: 「CI 全 pass。修正 N ラウンド（内容一行ずつ）」
- 止めた場合: どのチェックが / なぜ直せなかったか / 次に人が見るべきログの URL

## 注意

- このスキルは CI 以外を見ない。watch 中に review comment が付いていても **触れない・言及しない**（見に行かない）
- セッションが終わればループも終わる。長時間見張るならセッションを開いたままにする
- `<ci-monitor-event>` が流れてきた場合（Desktop 側のチェックが ON のとき）: 二重対応になるので、Desktop 側を OFF にするようユーザーに一言伝え、このスキルのループだけを継続する
