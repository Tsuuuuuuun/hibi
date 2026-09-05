#!/usr/bin/env node
// assets/favicon.svg から apple-touch-icon.png（180×180）を書き出す。
//
//   node scripts/icon.mjs
//
// ページのビルドには関わらない。favicon.svg の形を変えたときだけ手で走らせて、
// 出てきた assets/apple-touch-icon.png をコミットする。
//
// ラスタライズは npx で呼ぶだけにしてある（sharp-cli）。依存として入れると
// このリポジトリの node_modules がゼロでなくなるが、年に一度動かすかどうかの処理に
// それは見合わない。npx なら package.json も node_modules も動かない。
//
// 角丸は落とす。iOS はホーム画面に置くときアイコンを自前の角丸（約 22.4%）で抜くので、
// SVG 側でも丸めると二重にかかる。favicon.svg の rx は 5.5（32 に対して 17.2%）で
// iOS のマスクより内側なので、残すと角に墨の余りが出る。

import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'assets', 'favicon.svg')
const out = join(root, 'assets', 'apple-touch-icon.png')
const SIZE = 180

let svg = readFileSync(src, 'utf8')

// favicon.svg を直に加工するので、当てにしている書き方が残っているか先に確かめる。
// 形を描き直したあとに黙って違うものが出てくるより、ここで止まったほうがいい。
const cuts = [
  [/\s*<clipPath id="t">.*?<\/clipPath>/s, ''],   // 板の外へ出る柱は viewBox が切ってくれる
  [/\s+clip-path="url\(#t\)"/, ''],
  [/(<rect width="32" height="32")\s+rx="[\d.]+"/, '$1'],  // 角丸を落とす（iOS が自分で抜く）
  [/(<svg\b[^>]*?)>/, `$1 width="${SIZE}" height="${SIZE}">`],
]
for (const [re, to] of cuts) {
  if (!re.test(svg)) {
    console.error(`icon: assets/favicon.svg に ${re} が見つからない。書き換えたなら scripts/icon.mjs も直す`)
    process.exit(1)
  }
  svg = svg.replace(re, to)
}

// sharp-cli は出力先をディレクトリで取り、名前は入力から作る。欲しい名前で置く。
const tmp = mkdtempSync(join(tmpdir(), 'hibi-icon-'))
try {
  writeFileSync(join(tmp, 'apple-touch-icon.svg'), svg)
  const r = spawnSync('npx', [
    '-y', 'sharp-cli@6',
    '--input', join(tmp, 'apple-touch-icon.svg'),
    '--output', tmp,
    '--format', 'png',
    'resize', String(SIZE), String(SIZE),
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  if (r.status !== 0) {
    console.error('icon: sharp-cli が失敗した')
    process.exit(1)
  }
  copyFileSync(join(tmp, 'apple-touch-icon.png'), out)
  console.log(`icon: assets/apple-touch-icon.png (${SIZE}×${SIZE})`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
