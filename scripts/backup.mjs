#!/usr/bin/env node
// content/ の写しを R2 に取る。同期（scripts/deploy.mjs）の最後に毎回走るほか、単独でも動く。
//
//   node scripts/backup.mjs             → 変わったファイルだけ上げる
//   node scripts/backup.mjs --dry-run   → 上げるはずのものを出して終わる（LIST はする、PUT はしない）
//
// content/ は gitignore されていて履歴がどこにもないので、ここが唯一の写し。
// 置き先は写真（HIBI_R2_BUCKET）とは別のバケット HIBI_R2_BACKUP_BUCKET。
// 写真のバケットはカスタムドメインで丸ごと公開されるので、本文の写しを同じ所には置かない。
//
// キーは content/ からの相対パスそのまま（content/2026/08/30/14-59.md）。
// R2 の LIST が返す etag は単一 PUT なら中身の MD5 なので、手元の MD5 と比べて違うものだけ送る。
// 手元で消したファイルは R2 から消さない。消しても戻せる場所にしておくため。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, dirname, extname, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const API = 'https://api.cloudflare.com/client/v4'
const PREFIX = 'content/'

const MIME = {
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
}

const md5 = (buf) => createHash('md5').update(buf).digest('hex')

function collect(dir, base = dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      files.push(...collect(abs, base))
      continue
    }
    const buf = readFileSync(abs)
    files.push({
      key: PREFIX + relative(base, abs).split(sep).join('/'),
      buf,
      md5: md5(buf),
      type: MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
    })
  }
  return files
}

async function call(r2, path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${r2.token}`, ...headers },
    body,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${method} ${path} が JSON を返さなかった（${res.status}）${text.slice(0, 200)}`)
  }
  if (!res.ok || json.success === false) {
    const errs = (json.errors || []).map((e) => `${e.code}: ${e.message}`).join(', ') || text.slice(0, 200)
    throw new Error(`${method} ${path} が失敗（${res.status}）${errs}`)
  }
  return json
}

// R2 にあるものの MD5。1000 件ずつ、cursor が尽きるまで。
async function remoteHashes(r2) {
  const hashes = new Map()
  let cursor
  do {
    const q = new URLSearchParams({ prefix: PREFIX, per_page: '1000' })
    if (cursor) q.set('cursor', cursor)
    const json = await call(r2, `/accounts/${r2.accountId}/r2/buckets/${r2.bucket}/objects?${q}`)
    for (const o of json.result || []) hashes.set(o.key, String(o.etag || '').replace(/"/g, ''))
    cursor = json.result_info?.is_truncated ? json.result_info.cursor : null
  } while (cursor)
  return hashes
}

// .env を読んで設定を組む。バケットが無ければ null（写しは取らない）。
export function backupConfig() {
  const envFile = join(root, '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  const bucket = process.env.HIBI_R2_BACKUP_BUCKET
  if (!bucket) return null
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.HIBI_R2_TOKEN || process.env.CLOUDFLARE_API_TOKEN
  const missing = [!accountId && 'CLOUDFLARE_ACCOUNT_ID', !token && 'CLOUDFLARE_API_TOKEN'].filter(Boolean)
  if (missing.length) throw new Error(`HIBI_R2_BACKUP_BUCKET があるのに ${missing.join('・')} がない`)
  return { bucket, accountId, token }
}

// 変わったものだけ上げる。log は一行ずつ受け取る（deploy.mjs が画面へ流すため）。
export async function backup(r2, { content = join(root, 'content'), dryRun = false, log = console.log } = {}) {
  if (!existsSync(content)) throw new Error(`${relative(root, content)}/ がない`)
  const files = collect(content)
  const remote = await remoteHashes(r2)
  const changed = files.filter((f) => remote.get(f.key) !== f.md5)
  const unchanged = files.length - changed.length

  if (dryRun) {
    for (const f of changed) log(`${remote.has(f.key) ? 'update' : 'new   '}  ${f.key}`)
    log(`dry-run: ${changed.length} files → ${r2.bucket}（変わっていない ${unchanged}）`)
    return { changed: changed.length, unchanged }
  }

  for (const f of changed) {
    await call(r2, `/accounts/${r2.accountId}/r2/buckets/${r2.bucket}/objects/${f.key}`, {
      method: 'PUT',
      headers: { 'content-type': f.type },
      body: f.buf,
    })
  }
  log(`backup: ${changed.length} files → ${r2.bucket}（変わっていない ${unchanged}）`)
  return { changed: changed.length, unchanged }
}

// 単独で動かしたとき
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes('--dry-run')
  try {
    const r2 = backupConfig()
    if (!r2) {
      console.error('backup: HIBI_R2_BACKUP_BUCKET がない')
      process.exit(1)
    }
    await backup(r2, { content: resolve(root, process.env.HIBI_CONTENT || 'content'), dryRun })
  } catch (e) {
    console.error(`backup: ${e.message}`)
    process.exit(1)
  }
}
