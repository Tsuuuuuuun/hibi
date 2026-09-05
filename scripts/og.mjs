#!/usr/bin/env node
// 家の板（og:image）を assets/og.png に焼く。1200×630。
//
//   node scripts/og.mjs
//
// ページのビルドには関わらない。印を変えたときだけ手で走らせて、出てきた PNG をコミットする。
//
// 板の絵は印そのもの。地を墨で塗ると印の角丸の板は地に溶けて見えなくなり、
// 白い空きだけが大きく残る。文字は入れない。
// 白い板だと Slack のように白い面に置かれたとき縁が消えるが、墨なら必ず立つ。
//
// 寸法は assets/favicon.svg から読む。形の出どころを二つに増やさないため。
// 白い矩形が見える中身（日付の柱と本文の柱）、墨の矩形が罫。罫は地と同じ色なので
// 柱を横切るところにしか出ず、位置合わせには数えない。

import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'assets', 'og.png')

const W = 1200
const H = 630
const INK = '#17181A'
// 印の 32 の升目を何倍で置くか。日付の柱の幅が 6.5 なので 20 倍で 130px になる。
// 大きさはここだけで決まる。
const SCALE = 20
// 中身の上端を板のどこに置くか。構図の話なので寸法から導かれるものではない。
const TOP = 150

const svg = readFileSync(join(root, 'assets', 'favicon.svg'), 'utf8')

// 角丸で切っている中身のところだけを見る（外の板の矩形は地になるので要らない）。
const inner = svg.match(/<g clip-path="url\(#t\)">([\s\S]*?)<\/g>/)?.[1]
if (!inner) {
  console.error('og: assets/favicon.svg の中身（<g clip-path>）が読めない。書き換えたなら scripts/og.mjs も直す')
  process.exit(1)
}

const num = (s, k) => Number(s.match(new RegExp(`\\b${k}="([-\\d.]+)"`))?.[1] ?? 0)
const rects = [...inner.matchAll(/<rect\b[^>]*\/>/g)].map(m => m[0]).map(r => ({
  x: num(r, 'x'), y: num(r, 'y'), w: num(r, 'width'), h: num(r, 'height'), rx: num(r, 'rx'),
  white: /fill="#FFFFFF"/i.test(r),
}))

const solid = rects.filter(r => r.white)
if (solid.length < 2 || solid.length === rects.length) {
  console.error(`og: 白い矩形が ${solid.length} / ${rects.length} 個。favicon.svg の作りが変わっている`)
  process.exit(1)
}

// 横は白い中身の左右で中央に合わせる。罫は地と同じ色で見えないので数えない。
const left = Math.min(...solid.map(r => r.x))
const right = Math.max(...solid.map(r => r.x + r.w))
const ox = (W - (right - left) * SCALE) / 2 - left * SCALE
// 縦は白い中身の上端を TOP に置く。本文の柱は板の下から抜ける（viewBox が切る）。
const oy = TOP - Math.min(...solid.map(r => r.y)) * SCALE

const at = r =>
  `<rect x="${(r.x * SCALE + ox).toFixed(1)}" y="${(r.y * SCALE + oy).toFixed(1)}"` +
  ` width="${(r.w * SCALE).toFixed(1)}" height="${(r.h * SCALE).toFixed(1)}"` +
  ` rx="${(r.rx * SCALE).toFixed(1)}" fill="${r.white ? '#FFFFFF' : INK}"/>`

const board = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${INK}"/>
  ${rects.map(at).join('\n  ')}
</svg>
`

// sharp-cli は出力先をディレクトリで取り、名前は入力から作る。欲しい名前で置く。
const tmp = mkdtempSync(join(tmpdir(), 'hibi-og-'))
try {
  writeFileSync(join(tmp, 'og.svg'), board)
  const r = spawnSync('npx', [
    '-y', 'sharp-cli@6',
    '--input', join(tmp, 'og.svg'),
    '--output', tmp,
    '--format', 'png',
    'resize', String(W), String(H),
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  if (r.status !== 0 || !existsSync(join(tmp, 'og.png'))) {
    console.error('og: sharp-cli が失敗した')
    process.exit(1)
  }
  copyFileSync(join(tmp, 'og.png'), out)
  console.log(`og: assets/og.png (${W}×${H})`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
