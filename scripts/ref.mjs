#!/usr/bin/env node
// 記法のデモページをビルドして開く。ref/ の md を「今日の日記」として組み立て、
// 一時ディレクトリにビルドしてローカルサーバで見せる。content/ と site/ には触らない。
//
//   node scripts/ref.mjs        → http://localhost:8899/ を開く
//   PORT=9000 node scripts/ref.mjs
//
// ref/ を編集すると作り直すので、記法を試す場所としても使える。

import { cpSync, mkdirSync, rmSync, mkdtempSync, watch, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'ref')
const pad = (n) => String(n).padStart(2, '0')

if (!existsSync(src)) {
  console.error('ref: ref/ がない')
  process.exit(1)
}

const now = new Date()
const day = [String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate())]

const tmp = mkdtempSync(join(tmpdir(), 'hibi-ref-'))
const content = join(tmp, 'content')
const dayDir = join(content, ...day)

// ref/ の中身をその日のディレクトリに置く。md も画像もそのまま日記として扱われる。
const sync = () => {
  rmSync(dayDir, { recursive: true, force: true })
  mkdirSync(dayDir, { recursive: true })
  cpSync(src, dayDir, { recursive: true })
}
sync()

const port = Number(process.env.PORT) || 8899
const url = `http://localhost:${port}/${day.join('/')}/`

const build = spawn(process.execPath, [join(root, 'build.mjs'), '--watch'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, HIBI_CONTENT: content, HIBI_OUT: join(tmp, 'site'), PORT: String(port) },
})

// ref/ の変更を 100ms でまとめて写す。写した先を build.mjs が見ているので再ビルドが走る。
let timer = null
watch(src, { recursive: true }, () => {
  clearTimeout(timer)
  timer = setTimeout(sync, 100)
})

const cleanup = () => {
  build.kill()
  rmSync(tmp, { recursive: true, force: true })
}
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0))
build.on('exit', (code) => process.exit(code ?? 0))

setTimeout(() => {
  console.log(`ref: ${url}`)
  const open = { darwin: 'open', win32: 'start' }[process.platform] || 'xdg-open'
  spawn(open, [url], { stdio: 'ignore', shell: process.platform === 'win32', detached: true }).unref()
}, 700)
