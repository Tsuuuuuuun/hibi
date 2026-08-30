#!/usr/bin/env node
// site/ を Cloudflare Workers の Static Assets に直接アップロードする。
// Cloudflare 側でビルドが走らないので、無料プランの月 500 回のビルド枠を消費しない。
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/deploy.mjs
//   node scripts/deploy.mjs --name hibi        → Worker 名を指定（既定は hibi）
//   node scripts/deploy.mjs --workers-dev      → <name>.<subdomain>.workers.dev を有効にする
//   node scripts/deploy.mjs --dry-run          → 送るマニフェストを出して終わる（通信しない）
//   node scripts/deploy.mjs --force            → 同名の別の Worker があっても上書きする
//
// API トークンは「Workers スクリプト:編集」の権限のものを使う。
// アカウント ID は Cloudflare ダッシュボードの Workers & Pages の右側に出ている。
// 二つはリポジトリ直下の .env に置いてもよい（gitignore 済み）。環境変数のほうが優先される。
//
// アップロードは三段階。
//   1. マニフェスト（パス → ハッシュ・サイズ）を送り、まだ持っていないファイルを教えてもらう
//   2. 足りないファイルだけを base64 で送る
//   3. 完了トークンを添えて Worker 本体を更新する
// ハッシュは sha256(base64(内容) + 拡張子) の先頭 32 桁。node:crypto だけで計算できる。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, extname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, process.env.HIBI_OUT || 'site')
const API = 'https://api.cloudflare.com/client/v4'

// .env があれば読む。すでに環境変数にあるものはそちらが勝つ。
const envFile = join(root, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const die = (msg) => {
  console.error(`deploy: ${msg}`)
  process.exit(1)
}

/* ---------------- 引数と設定 ---------------- */

let name = process.env.HIBI_WORKER_NAME || 'hibi'
let workersDev = false
let dryRun = false
let force = false

const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--name') {
    name = argv[++i] || die('--name の値がない')
  } else if (arg === '--workers-dev') {
    workersDev = true
  } else if (arg === '--dry-run') {
    dryRun = true
  } else if (arg === '--force') {
    force = true
  } else {
    die(`知らないオプション: ${arg}`)
  }
}

const accountId = dryRun ? '-' : process.env.CLOUDFLARE_ACCOUNT_ID || die('CLOUDFLARE_ACCOUNT_ID がない')
const token = dryRun ? '-' : process.env.CLOUDFLARE_API_TOKEN || die('CLOUDFLARE_API_TOKEN がない')

if (!existsSync(join(out, 'index.html'))) {
  die(`${relative(root, out)}/ にビルド結果がない（先に npm run build）`)
}

/* ---------------- ファイルの収集 ---------------- */

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.xml': 'application/xml', '.json': 'application/json', '.txt': 'text/plain',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
}

// Static Assets のハッシュ。base64 にした中身とドットなしの拡張子をつないで sha256 する。
const assetHash = (base64, ext) =>
  createHash('sha256').update(base64 + ext).digest('hex').slice(0, 32)

function collect(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      files.push(...collect(abs))
      continue
    }
    const buf = readFileSync(abs)
    const base64 = buf.toString('base64')
    const ext = extname(abs)
    files.push({
      // マニフェストのキーは先頭スラッシュ付きの URL パス
      path: '/' + relative(out, abs).split(sep).join('/'),
      hash: assetHash(base64, ext.slice(1)),
      size: buf.length,
      type: MIME[ext.toLowerCase()] || 'application/octet-stream',
      base64,
    })
  }
  return files
}

const files = collect(out)
if (!files.length) die(`${relative(root, out)}/ が空`)

/* ---------------- API ---------------- */

async function api(path, { method = 'POST', auth = token, body, headers = {}, allow404 = false } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${auth}`, ...headers },
    body,
  })
  if (allow404 && res.status === 404) return null
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    die(`${method} ${path} が JSON を返さなかった（${res.status}）\n${text.slice(0, 400)}`)
  }
  if (!res.ok || json.success === false) {
    const errs = (json.errors || []).map((e) => `${e.code}: ${e.message}`).join('\n  ') || text.slice(0, 400)
    die(`${method} ${path} が失敗（${res.status}）\n  ${errs}`)
  }
  return json.result
}

/* ---------------- 1. マニフェスト ---------------- */

const manifest = Object.fromEntries(files.map((f) => [f.path, { hash: f.hash, size: f.size }]))

if (dryRun) {
  for (const f of files) console.log(`${f.hash}  ${String(f.size).padStart(7)}  ${f.type}  ${f.path}`)
  console.log(`dry-run: ${files.length} files → ${name}`)
  process.exit(0)
}

// 同名の Worker がすでにある場合、それがこのスクリプトの作ったものか確かめる。
// 無関係の Worker を黙って上書きしないための確認。--force で飛ばせる。
const existing = await api(`/accounts/${accountId}/workers/scripts/${name}/settings`, {
  method: 'GET',
  allow404: true,
})
if (existing && !force) {
  const ours = (existing.bindings || []).some((b) => b.type === 'assets' && b.name === 'ASSETS')
  if (!ours) {
    die(
      `Worker「${name}」はすでにあり、このスクリプトが作ったものではない。\n` +
        `  別の名前を使う（--name か HIBI_WORKER_NAME）か、上書きしてよければ --force`
    )
  }
}
console.log(existing ? `target: ${name}（更新）` : `target: ${name}（新規作成）`)

const session = await api(`/accounts/${accountId}/workers/scripts/${name}/assets-upload-session`, {
  body: JSON.stringify({ manifest }),
  headers: { 'content-type': 'application/json' },
})

// buckets が空なら、全ファイルが Cloudflare 側に揃っている。session.jwt がそのまま完了トークン。
const buckets = session?.buckets || []
let completion = session?.jwt

/* ---------------- 2. 足りないファイルの送信 ---------------- */

if (buckets.length) {
  const byHash = new Map(files.map((f) => [f.hash, f]))
  const total = buckets.reduce((n, b) => n + b.length, 0)
  let done = 0

  for (const bucket of buckets) {
    const form = new FormData()
    for (const hash of bucket) {
      const file = byHash.get(hash)
      if (!file) die(`知らないハッシュが返ってきた: ${hash}`)
      // 中身は base64 の文字列そのものを送る（URL の base64=true と対応する）
      form.set(hash, new File([file.base64], hash, { type: file.type }))
    }
    const result = await api(`/accounts/${accountId}/workers/assets/upload?base64=true`, {
      auth: session.jwt,
      body: form,
    })
    // 最後のバケットの応答に完了トークンが入る
    if (result?.jwt) completion = result.jwt
    done += bucket.length
    console.log(`uploaded: ${done}/${total}`)
  }
} else {
  console.log('uploaded: 0/0（すべてキャッシュ済み）')
}

if (!completion) die('完了トークンが返ってこなかった')

/* ---------------- 3. Worker の更新 ---------------- */

// アセットにない URL も含めてすべてアセットルータに渡す。
// html_handling / not_found_handling の解決（末尾スラッシュ、404.html）はここで効く。
const worker = `export default {
  fetch(request, env) {
    return env.ASSETS.fetch(request)
  },
}
`

const metadata = {
  main_module: 'main.js',
  compatibility_date: '2026-08-01',
  bindings: [{ type: 'assets', name: 'ASSETS' }],
  assets: {
    jwt: completion,
    config: {
      // /2026/08/30 を /2026/08/30/ に寄せる（Pages の既定と同じ挙動）
      html_handling: 'auto-trailing-slash',
      // どのアセットにも当たらない URL に 404.html を返す
      not_found_handling: '404-page',
    },
  },
}

const form = new FormData()
form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
form.set('main.js', new File([worker], 'main.js', { type: 'application/javascript+module' }))

await api(`/accounts/${accountId}/workers/scripts/${name}`, { method: 'PUT', body: form })

if (workersDev) {
  await api(`/accounts/${accountId}/workers/scripts/${name}/subdomain`, {
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
    headers: { 'content-type': 'application/json' },
  })
}

console.log(`deployed: ${files.length} files → ${name}`)
