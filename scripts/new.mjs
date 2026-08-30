#!/usr/bin/env node
// 記事ファイルを content/ に作る。既定は実行時の日付・時刻。
// 引数に文章を書くと、それが本文になる。
//
//   node scripts/new.mjs                          → content/2026/08/30/11-55.md（空）
//   node scripts/new.mjs "今日のこと。"           → 同じファイルに本文を入れて作る
//   node scripts/new.mjs -d 2026-08-29 -t 21:30   → 日付・時刻を手で指定する

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pad = (n) => String(n).padStart(2, '0')

const die = (msg) => {
  console.error(`new: ${msg}`)
  process.exit(1)
}

const now = new Date()
let yyyy = String(now.getFullYear())
let mm = pad(now.getMonth() + 1)
let dd = pad(now.getDate())
let hh = pad(now.getHours())
let mi = pad(now.getMinutes())

const words = []
const argv = process.argv.slice(2)

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]

  if (arg === '--') {
    words.push(...argv.slice(i + 1))
    break
  }

  if (arg === '-d' || arg === '--date') {
    const value = argv[++i]
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value ?? '')
    if (!m) die(`日付は YYYY-MM-DD で指定する（受け取った値: ${value ?? 'なし'}）`)
    const [, y, mo, d] = m
    const date = new Date(Number(y), Number(mo) - 1, Number(d))
    if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) {
      die(`そんな日付はない: ${value}`)
    }
    yyyy = y
    mm = pad(mo)
    dd = pad(d)
    continue
  }

  if (arg === '-t' || arg === '--time') {
    const value = argv[++i]
    const m = /^(\d{1,2})[:\-.](\d{2})$/.exec(value ?? '')
    if (!m) die(`時刻は HH:MM で指定する（受け取った値: ${value ?? 'なし'}）`)
    const [, h, min] = m
    if (Number(h) > 23 || Number(min) > 59) die(`そんな時刻はない: ${value}`)
    hh = pad(h)
    mi = pad(min)
    continue
  }

  if (arg.startsWith('-') && arg.length > 1 && words.length === 0) {
    die(`知らないオプション: ${arg}（本文が - で始まるときは -- の後ろに書く）`)
  }

  words.push(arg)
}

const dir = join(root, 'content', yyyy, mm, dd)
const file = join(dir, `${hh}-${mi}.md`)
const rel = `content/${yyyy}/${mm}/${dd}/${hh}-${mi}.md`

const body = words.join(' ').trim()

mkdirSync(dir, { recursive: true })

if (!existsSync(file)) {
  writeFileSync(file, body ? body + '\n' : '')
  console.log(`${rel} を作成${body ? '（本文あり）' : ''}`)
} else if (body) {
  const current = readFileSync(file, 'utf8')
  if (current.trim() === '') {
    writeFileSync(file, body + '\n')
  } else {
    appendFileSync(file, (current.endsWith('\n') ? '' : '\n') + '\n' + body + '\n')
  }
  console.log(`${rel} に追記`)
} else {
  console.log(`${rel} はすでにある`)
}
