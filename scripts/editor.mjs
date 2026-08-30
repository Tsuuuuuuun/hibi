// 「書く画面」のサーバ。build.mjs の --watch のときだけ、確認サーバに /_write として乗る。
// content/YYYY/MM/DD/HH-MM.md を読み書きするだけで、記事の組み立ては build.mjs に任せる。
//
//   http://localhost:8888/_write
//
// 保存すると再ビルドの完了を待ってから返すので、返ったときにはもう日ページが新しい。

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE = path.join(HERE, 'editor.html')

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^(\d{2}):(\d{2})$/
// 日記に置ける画像は build.mjs が寸法を読める JPEG/PNG だけ
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png' }
const MAX_IMAGE = 20 * 1024 * 1024
// 写真は記事の md と混ぜず、日ディレクトリの下の img/ に置く
const IMG = 'img'

const pad = (n) => String(n).padStart(2, '0')

// 日付・時刻はそのままファイルパスになる。実在する日付かどうかまで見る。
function badTarget(date, time) {
  const d = DATE_RE.exec(date ?? '')
  if (!d) return `日付は YYYY-MM-DD で指定する（受け取った値: ${date ?? 'なし'}）`
  const [, y, mo, da] = d.map(Number)
  const dt = new Date(y, mo - 1, da)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== da) return `そんな日付はない: ${date}`
  const t = TIME_RE.exec(time ?? '')
  if (!t) return `時刻は HH:MM で指定する（受け取った値: ${time ?? 'なし'}）`
  if (Number(t[1]) > 23 || Number(t[2]) > 59) return `そんな時刻はない: ${time}`
  return null
}

const dayDir = (root, date) => path.join(root, ...date.split('-'))
const entryFile = (root, date, time) => path.join(dayDir(root, date), `${time.replace(':', '-')}.md`)

const subdirs = (dir, re) => fs.readdirSync(dir)
  .filter((f) => re.test(f) && fs.statSync(path.join(dir, f)).isDirectory())
  .sort()

// 一覧に出す一行。本文の最初の行から、記法の印だけ落として拾う。
function excerpt(file) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    return s
      .replace(/^!\[(.*)\]\(.+\)$/, (_, cap) => `写真${cap ? `（${cap}）` : ''}`)
      .replace(/^[>\-]\s*/, '')
      .slice(0, 60)
  }
  return ''
}

// 日付は新しい順、同じ日の中は時刻順（月ページと同じ並び）
function listEntries(root) {
  const days = []
  if (!fs.existsSync(root)) return days
  for (const y of subdirs(root, /^\d{4}$/)) {
    for (const m of subdirs(path.join(root, y), /^\d{2}$/)) {
      for (const d of subdirs(path.join(root, y, m), /^\d{2}$/)) {
        const dir = path.join(root, y, m, d)
        const times = fs.readdirSync(dir)
          .filter((f) => /^\d{2}-\d{2}\.md$/.test(f))
          .sort()
          .map((f) => ({ time: f.slice(0, 5).replace('-', ':'), excerpt: excerpt(path.join(dir, f)) }))
        if (times.length) days.push({ date: `${y}-${m}-${d}`, times })
      }
    }
  }
  return days.sort((a, b) => b.date.localeCompare(a.date))
}

// 名前は貼った時刻にする。日付はディレクトリが持っているので、本文の HH-MM.md と同じ考え方。
function stampName(dir, ext) {
  const d = new Date()
  const stamp = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  if (!fs.existsSync(path.join(dir, stamp + ext))) return stamp + ext
  // 同じ秒に二枚入ったときだけ、後ろに短いランダムを足す（連番にはしない）
  for (;;) {
    const id = Array.from({ length: 3 }, () => randomInt(36).toString(36)).join('')
    if (!fs.existsSync(path.join(dir, `${stamp}-${id}${ext}`))) return `${stamp}-${id}${ext}`
  }
}

// その日のすべての md が参照している写真の名前。img/ を付けて書いても付けなくても拾う。
function referenced(dir) {
  const names = new Set()
  for (const f of fs.readdirSync(dir)) {
    if (!/^\d{2}-\d{2}\.md$/.test(f)) continue
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    for (const m of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) names.add(path.basename(m[1].trim()))
  }
  return names
}

// どの本文からも参照されなくなった写真を img/ から消す。保存・削除のたびに通る。
// 日ディレクトリに手で置いた写真には触らない（消していいのは img/ の中だけ）。
function sweepImages(root, date) {
  const dir = dayDir(root, date)
  const imgDir = path.join(dir, IMG)
  if (!fs.existsSync(imgDir)) return []
  const keep = referenced(dir)
  const gone = []
  for (const f of fs.readdirSync(imgDir)) {
    if (!/\.(jpe?g|png)$/i.test(f) || keep.has(f)) continue
    fs.rmSync(path.join(imgDir, f))
    gone.push(f)
  }
  if (!fs.readdirSync(imgDir).length) fs.rmdirSync(imgDir)
  return gone
}

// 同期（npm run deploy と同じこと）。ビルドは確認サーバのものを使い、
// アップロードだけ scripts/deploy.mjs に投げて、出力をそのまま画面へ流す。
let deploying = false

function runDeploy(root, res) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'deploy.mjs')], { cwd: root })
    child.stdout.on('data', (c) => res.write(c))
    child.stderr.on('data', (c) => res.write(c))
    child.on('error', (e) => resolve({ code: 1, error: e.message }))
    child.on('close', (code) => resolve({ code: code ?? 1 }))
  })
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body))
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error(`本文が大きすぎる（上限 ${Math.round(limit / 1024 / 1024)}MB）`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// 確認サーバは全インターフェースで待つ（同じ Wi-Fi のスマホから見るため）。
// 書ける口はこの手元からだけに限る。
const local = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)

// build.mjs の確認サーバから呼ぶ。/_write を受け持ったら true を返す。
export function editorHandler(ctx) {
  return async function handle(req, res, url) {
    if (url !== '/_write' && !url.startsWith('/_write/')) return false
    if (!local(req)) {
      json(res, 403, { error: '書く画面はこの機械からだけ' })
      return true
    }
    try {
      await route(req, res, url, ctx)
    } catch (e) {
      // 同期の出力を流し始めたあとは、もうヘッダを書けない
      if (res.headersSent) res.end(`\ndeploy: ${e.message}\n--- ng\n`)
      else json(res, 500, { error: e.message })
    }
    return true
  }
}

async function route(req, res, url, { content, rebuild, root, canDeploy }) {
  const query = new URL(req.url, 'http://localhost').searchParams
  const endpoint = url.replace(/^\/_write\/?/, '')

  // 画面そのもの。読むたびにファイルから読むので、いじったら再読み込みで反映される。
  if (endpoint === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fs.readFileSync(PAGE))
    return
  }

  // 画面が起動時に一度だけ聞く。確認用のビルド（npm run ref）では同期ボタンを出さない。
  if (endpoint === 'config' && req.method === 'GET') {
    json(res, 200, { deploy: canDeploy })
    return
  }

  if (endpoint === 'deploy' && req.method === 'POST') {
    if (!canDeploy) return json(res, 403, { error: 'この確認サーバは content/ を見ていないので同期しない' })
    if (deploying) return json(res, 409, { error: 'すでに同期している' })
    deploying = true
    // 行ごとに流す。最後の一行だけが結果（--- ok / --- ng）で、あとは deploy.mjs の出力そのまま。
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    try {
      res.write('ビルドしている…\n')
      await rebuild()
      const { code, error } = await runDeploy(root, res)
      if (error) res.write(`deploy: ${error}\n`)
      res.end(code === 0 ? '--- ok\n' : `--- ng ${code}\n`)
    } finally {
      deploying = false
    }
    return
  }

  if (endpoint === 'entries' && req.method === 'GET') {
    json(res, 200, { days: listEntries(content) })
    return
  }

  if (endpoint === 'entry' && req.method === 'GET') {
    const date = query.get('date')
    const time = query.get('time')
    const bad = badTarget(date, time)
    if (bad) return json(res, 400, { error: bad })
    const file = entryFile(content, date, time)
    const exists = fs.existsSync(file)
    json(res, 200, { exists, text: exists ? fs.readFileSync(file, 'utf8') : '' })
    return
  }

  if (endpoint === 'entry' && req.method === 'POST') {
    const { date, time, text } = JSON.parse(String(await readBody(req, 4 * 1024 * 1024)) || '{}')
    const bad = badTarget(date, time)
    if (bad) return json(res, 400, { error: bad })
    const file = entryFile(content, date, time)
    const body = String(text ?? '').replace(/\s+$/, '')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body ? body + '\n' : '')
    const swept = sweepImages(content, date)
    await rebuild()
    const now = new Date()
    console.log(`saved: ${path.relative(content, file)}`)
    if (swept.length) console.log(`swept: ${date} ${IMG}/ から ${swept.join(', ')}`)
    json(res, 200, { ok: true, at: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` })
    return
  }

  if (endpoint === 'entry' && req.method === 'DELETE') {
    const { date, time } = JSON.parse(String(await readBody(req, 64 * 1024)) || '{}')
    const bad = badTarget(date, time)
    if (bad) return json(res, 400, { error: bad })
    const file = entryFile(content, date, time)
    if (!fs.existsSync(file)) return json(res, 404, { error: 'そのファイルはない' })
    fs.rmSync(file)
    const swept = sweepImages(content, date)
    // 空になった日・月・年のディレクトリは残さない
    for (let dir = path.dirname(file); dir.startsWith(content + path.sep); dir = path.dirname(dir)) {
      if (fs.readdirSync(dir).length) break
      fs.rmdirSync(dir)
    }
    await rebuild()
    console.log(`deleted: ${date} ${time}`)
    if (swept.length) console.log(`swept: ${date} ${IMG}/ から ${swept.join(', ')}`)
    json(res, 200, { ok: true })
    return
  }

  if (endpoint === 'image' && req.method === 'POST') {
    const date = query.get('date')
    const bad = badTarget(date, '00:00')
    if (bad) return json(res, 400, { error: bad })
    const ext = IMAGE_EXT[String(req.headers['content-type']).split(';')[0]]
    if (!ext) return json(res, 400, { error: '写真は JPEG か PNG だけ' })
    const dir = path.join(dayDir(content, date), IMG)
    fs.mkdirSync(dir, { recursive: true })
    const name = stampName(dir, ext)
    fs.writeFileSync(path.join(dir, name), await readBody(req, MAX_IMAGE))
    await rebuild()
    console.log(`added: ${date} ${IMG}/${name}`)
    json(res, 200, { name, ref: `${IMG}/${name}` })
    return
  }

  json(res, 404, { error: `知らない道: ${url}` })
}
