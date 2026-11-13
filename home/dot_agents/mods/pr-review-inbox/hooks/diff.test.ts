import { expect, test } from 'claude-code/testing'

import { hunkAt } from './diff'

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
