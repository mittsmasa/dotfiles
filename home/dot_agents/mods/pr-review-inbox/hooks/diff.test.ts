import { expect, test } from 'claude-code/testing'

import { fileDiff, filesOf, foldWhitespace, hunkAt, rowsOf, safeText } from './diff'

// src/a.ts has two hunks (right-side lines 10-12 and 40-41); src/b.ts has one (lines 1-2).
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,3 @@ function a() {',
  ' const x = 1',
  '-const old = 2',
  '+const y = 2',
  ' return x',
  '@@ -40,1 +40,2 @@',
  ' const z = 3',
  '+const w = 4',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,1 +1,2 @@',
  ' export {}',
  '+export const b = 1',
  '\\ No newline at end of file',
  '',
].join('\n')

test('hunkAt は指定した行を含む hunk を @@ 行ごと返す', () => {
  expect(hunkAt(DIFF, 'src/a.ts', 11)).toBe(
    ['@@ -10,3 +10,3 @@ function a() {', ' const x = 1', '-const old = 2', '+const y = 2', ' return x'].join('\n'),
  )
})

test('hunkAt は同じファイルに hunk が複数あるとき、行を含むほうを返す', () => {
  expect(hunkAt(DIFF, 'src/a.ts', 41)).toBe(['@@ -40,1 +40,2 @@', ' const z = 3', '+const w = 4'].join('\n'))
})

test('hunkAt は別のファイルの同じ行番号を取り違えない', () => {
  expect(hunkAt(DIFF, 'src/b.ts', 2)).toBe(
    ['@@ -1,1 +1,2 @@', ' export {}', '+export const b = 1', '\\ No newline at end of file'].join('\n'),
  )
})

test('hunkAt は差分に出ていない行には何も返さない', () => {
  expect(hunkAt(DIFF, 'src/a.ts', 20)).toBe(undefined)
})

test('hunkAt は差分に無いファイルには何も返さない', () => {
  expect(hunkAt(DIFF, 'src/gone.ts', 11)).toBe(undefined)
})

// ---- the diff screen: files, one file's hunks, rows ----

// One of each kind: changed, added, deleted, renamed with no change, binary.
const FIVE_KINDS = [
  'diff --git a/src/changed.ts b/src/changed.ts',
  'index 111..222 100644',
  '--- a/src/changed.ts',
  '+++ b/src/changed.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  'diff --git a/src/added.ts b/src/added.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/added.ts',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
  'diff --git a/src/deleted.ts b/src/deleted.ts',
  'deleted file mode 100644',
  '--- a/src/deleted.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-gone',
  'diff --git a/src/before.ts b/src/after.ts',
  'similarity index 100%',
  'rename from src/before.ts',
  'rename to src/after.ts',
  'diff --git a/logo.png b/logo.png',
  'index 111..222 100644',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n')

test('filesOf は変更、追加、削除、名前の変更だけ、バイナリのファイルを、パスと行数つきで並べる', () => {
  expect(filesOf(FIVE_KINDS)).toEqual([
    { path: 'src/changed.ts', added: 1, removed: 1 },
    { path: 'src/added.ts', added: 2, removed: 0 },
    { path: 'src/deleted.ts', added: 0, removed: 1 },
    { path: 'src/after.ts', added: 0, removed: 0 },
    { path: 'logo.png', added: 0, removed: 0 },
  ])
})

test('filesOf は空白を含むパスの末尾に git が付けるタブを落とす', () => {
  const diff = ['diff --git a/foo bar.ts b/foo bar.ts', '--- a/foo bar.ts\t', '+++ b/foo bar.ts\t', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n')

  expect(filesOf(diff)).toEqual([{ path: 'foo bar.ts', added: 1, removed: 1 }])
})

test('filesOf は hunk の中の --- や +++ で始まる行を、ファイル名と取り違えない', () => {
  const diff = ['diff --git a/x.md b/x.md', '--- a/x.md', '+++ b/x.md', '@@ -1,2 +1,2 @@', '--- a/fake', '+++ b/fake', ' keep'].join('\n')

  expect(filesOf(diff)).toEqual([{ path: 'x.md', added: 1, removed: 1 }])
})

const ROOMY = { chars: 50_000, rows: 1000 }

test('fileDiff は指定したファイルの hunk だけを返す', () => {
  expect(fileDiff(DIFF, 'src/b.ts', ROOMY)).toEqual({
    source: ['@@ -1,1 +1,2 @@', ' export {}', '+export const b = 1', '\\ No newline at end of file'].join('\n'),
    isCut: false,
  })
  // Two hunks: a header and four rows, a header and two.
  expect(fileDiff(DIFF, 'src/a.ts', ROOMY).source.split('\n')).toHaveLength(8)
})

test('fileDiff は hunk の無いファイルと、差分に無いファイルには空を返す', () => {
  expect(fileDiff(FIVE_KINDS, 'logo.png', ROOMY)).toEqual({ source: '', isCut: false })
  expect(fileDiff(FIVE_KINDS, 'src/nowhere.ts', ROOMY)).toEqual({ source: '', isCut: false })
})

test('fileDiff は行数の上限を超えると、行の区切りで切って isCut になる', () => {
  expect(fileDiff(DIFF, 'src/a.ts', { chars: 50_000, rows: 3 })).toEqual({
    source: ['@@ -10,3 +10,3 @@ function a() {', ' const x = 1', '-const old = 2'].join('\n'),
    isCut: true,
  })
})

test('fileDiff は文字数の上限を超える行の手前で切る', () => {
  // The header is 32 characters and its newline; the next row would pass 40.
  expect(fileDiff(DIFF, 'src/a.ts', { chars: 40, rows: 1000 })).toEqual({
    source: '@@ -10,3 +10,3 @@ function a() {',
    isCut: true,
  })
})

test('rowsOf: 追加、削除、文脈の行番号を hunk の見出しから数える', () => {
  expect(rowsOf(fileDiff(DIFF, 'src/a.ts', ROOMY).source)).toEqual([
    { kind: 'hunk', text: '@@ -10,3 +10,3 @@ function a() {' },
    { kind: 'context', oldLine: 10, newLine: 10, text: 'const x = 1' },
    { kind: 'remove', oldLine: 11, text: 'const old = 2' },
    { kind: 'add', newLine: 11, text: 'const y = 2' },
    { kind: 'context', oldLine: 12, newLine: 12, text: 'return x' },
    { kind: 'hunk', text: '@@ -40,1 +40,2 @@' },
    { kind: 'context', oldLine: 40, newLine: 40, text: 'const z = 3' },
    { kind: 'add', newLine: 41, text: 'const w = 4' },
  ])
})

test('rowsOf は No newline at end of file を行にしない', () => {
  expect(rowsOf(fileDiff(DIFF, 'src/b.ts', ROOMY).source).map(row => row.kind)).toEqual(['hunk', 'context', 'add'])
})

test('safeText は tab を空白 2 つに、制御文字と双方向の制御文字を U+FFFD に置き換える', () => {
  expect(safeText('a\tb')).toBe('a  b')
  expect(safeText('a\u0007b\u001b[31m')).toBe('a�b�[31m')
  expect(safeText('if (isAdmin‮ ⁦) {')).toBe('if (isAdmin� �) {')
  expect(safeText('const 合計 = 1 // ふつうの行')).toBe('const 合計 = 1 // ふつうの行')
})

// ---- folding changes of whitespace, and the left side ----

const rowsFrom = (...lines: string[]) => rowsOf(lines.join('\n'))

test('foldWhitespace: 字下げだけ変わった行は文脈行になり、文面は新しい側、行番号は両側を持つ', () => {
  const folded = foldWhitespace(rowsFrom('@@ -5,2 +5,3 @@', '-first()', '-second()', '+if (ok) {', '+  first()', '+\tsecond( )'))

  expect(folded).toEqual([
    { kind: 'hunk', text: '@@ -5,2 +5,3 @@' },
    { kind: 'add', newLine: 5, text: 'if (ok) {' },
    { kind: 'context', oldLine: 5, newLine: 6, text: '  first()' },
    { kind: 'context', oldLine: 6, newLine: 7, text: '\tsecond( )' },
  ])
})

test('foldWhitespace: 中身も変わった行は、削除行と追加行のまま残る', () => {
  const rows = rowsFrom('@@ -1,2 +1,2 @@', ' keep', '-const a = 1', '+const a = 2')

  expect(foldWhitespace(rows)).toEqual(rows)
})

test('foldWhitespace: 対にならなかった行は、削除行が先、追加行が後に並ぶ', () => {
  // `a` pairs with ` a`; `b` and `x` are left over, after the pair.
  expect(foldWhitespace(rowsFrom('@@ -1,2 +1,2 @@', '-a', '-b', '+ a', '+x'))).toEqual([
    { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
    { kind: 'context', oldLine: 1, newLine: 1, text: ' a' },
    { kind: 'remove', oldLine: 2, text: 'b' },
    { kind: 'add', newLine: 2, text: 'x' },
  ])
  // Left over ahead of a pair: the removed row first, then the added one, then the pair.
  expect(foldWhitespace(rowsFrom('@@ -1,2 +1,2 @@', '-gone', '-same', '+come', '+ same')).map(row => row.kind)).toEqual([
    'hunk',
    'remove',
    'add',
    'context',
  ])
})

test('foldWhitespace: 空白だけの変更しか無い hunk は出ず、全部そうなら空になる', () => {
  const only = rowsFrom('@@ -1,2 +1,2 @@', ' keep', '-a', '+  a')
  const real = rowsFrom('@@ -9,1 +9,1 @@', '-b', '+c')

  expect(foldWhitespace(only)).toEqual([])
  expect(foldWhitespace([...only, ...real])).toEqual(real)
})

test('foldWhitespace: 追加された空行は追加行のまま残る', () => {
  const rows = rowsFrom('@@ -1,1 +1,2 @@', ' keep', '+')

  expect(foldWhitespace(rows)).toEqual(rows)
})

test('hunkAt に LEFT を渡すと、変更前の行番号で削除行を探す', () => {
  // src/a.ts: old line 11 is removed (`const old = 2`); new line 11 is another row of the same hunk.
  expect(hunkAt(DIFF, 'src/a.ts', 11, 'LEFT')?.split('\n')[0]).toBe('@@ -10,3 +10,3 @@ function a() {')
  // Old line 40 is a context row, and old line 99 is not in the diff: neither is a removed line.
  expect(hunkAt(DIFF, 'src/a.ts', 40, 'LEFT')).toBe(undefined)
  expect(hunkAt(DIFF, 'src/a.ts', 99, 'LEFT')).toBe(undefined)
  // A deleted file has no new path: it goes by its old one.
  expect(hunkAt(FIVE_KINDS, 'src/deleted.ts', 1, 'LEFT')).toBe(['@@ -1,1 +0,0 @@', '-gone'].join('\n'))
})
