// 日ページに載せるエディタ。build.mjs の確認サーバが、手元から読んだ .html にだけ差し込む。
// site/ には入らないので、公開されるページにはこのファイルの痕跡がない。
//
// シートは一つで、開いた経路で書き込み先が決まる。
//   新規：右下の「＋」から。実行時の日付・時刻はサーバが決めるので、本文を送るだけ（POST /_write/post）
//   編集：各時刻ブロックの「編集」から。そのブロックの本文を置き換える（GET/POST/DELETE /_write/entry）
// 見出しの時刻は、新規では目安、編集では対象そのもの。
(() => {
  if (!window.fetch || !('showModal' in HTMLDialogElement.prototype)) return

  // 今いる日。canonical から取る（/ は最新の日ページの写しで、パスからは日が読めない）。
  // 日ページ以外（月一覧、404）には出さない。
  const canon = document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')
  const here = new URL(canon || location.href, location.href).pathname
  const hereDay = here.match(/^\/(\d{4})\/(\d{2})\/(\d{2})\/$/)?.slice(1).join('-') || ''
  if (!hereDay) return

  const pad = (n) => String(n).padStart(2, '0')
  const clock = () => {
    const d = new Date()
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  async function api(path, opts) {
    const res = await fetch('/_write/' + path, opts)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
    return body
  }
  const jsonOpts = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })

  // 再ビルドは済んでいるので、URL を保ったまま読み直す。/ で読んでいるときに /YYYY/MM/DD/ へ移らない。
  const reloadAt = (id) => {
    history.replaceState(null, '', location.pathname + (id ? '#' + id : ''))
    location.reload()
  }

  /* ---------------- 差し込む要素 ---------------- */

  const fab = document.createElement('button')
  fab.type = 'button'
  fab.className = 'edit-fab'
  fab.setAttribute('aria-label', '投稿')
  fab.textContent = '＋'

  const dlg = document.createElement('dialog')
  dlg.className = 'edit'
  dlg.innerHTML =
    '<form method="dialog" class="edit-form">' +
    '<div class="edit-head"><span class="edit-time"></span><span class="edit-note" aria-live="polite"></span></div>' +
    '<textarea class="edit-text" rows="6" placeholder="いま思ったこと" autocapitalize="off"></textarea>' +
    '<div class="edit-foot">' +
    '<span class="edit-left"><button type="button" class="edit-close">閉じる</button>' +
    '<button type="button" class="edit-delete" hidden>削除</button></span>' +
    '<button type="button" class="edit-submit">投稿</button>' +
    '</div></form>'
  document.body.append(fab, dlg)

  const el = {
    time: dlg.querySelector('.edit-time'),
    note: dlg.querySelector('.edit-note'),
    text: dlg.querySelector('.edit-text'),
    close: dlg.querySelector('.edit-close'),
    del: dlg.querySelector('.edit-delete'),
    submit: dlg.querySelector('.edit-submit'),
  }

  // 各時刻ブロックの見出し行（<time>）の右端に「編集」を置く。id は日ページにしかないので、月一覧には付かない。
  const segs = [...document.querySelectorAll('.seg[id]')]
  for (const seg of segs) {
    const head = seg.querySelector('time')
    if (!head) continue
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'edit-open'
    b.textContent = '編集'
    b.setAttribute('aria-label', `${seg.id.replace('-', ':')} を編集`)
    b.addEventListener('click', () => open(seg.id))
    head.append(b)
  }

  /* ---------------- 状態 ---------------- */

  let target = null   // 編集なら { id: '10-40', time: '10:40' }、新規なら null
  let busy = false
  let armed = false   // 削除の一度目を押したか

  const note = (msg, kind) => {
    el.note.textContent = msg
    el.note.className = 'edit-note' + (kind ? ' is-' + kind : '')
  }
  const setBusy = (on) => {
    busy = on
    el.submit.disabled = on
    el.del.disabled = on
  }
  const disarm = () => {
    armed = false
    el.del.textContent = '削除'
    el.del.classList.remove('is-armed')
  }

  async function open(id) {
    target = id ? { id, time: id.replace('-', ':') } : null
    disarm()
    note('')
    el.text.value = ''
    el.time.textContent = target ? target.time : clock()
    el.submit.textContent = target ? '保存' : '投稿'
    el.del.hidden = !target
    dlg.showModal()
    el.text.focus()
    if (!target) return
    // 本文はサーバから読む。読み終わるまで保存も削除もできないようにしておく。
    setBusy(true)
    note('読んでいる…')
    try {
      const { exists, text } = await api(`entry?date=${hereDay}&time=${target.time}`)
      el.text.value = exists ? text.replace(/\s+$/, '') : ''
      note(exists ? '' : 'このファイルはもう無い', 'ng')
    } catch (e) {
      note(e.message, 'ng')
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- 実行 ---------------- */

  async function submit() {
    if (busy) return
    const text = el.text.value.trim()
    if (!text) {
      el.text.focus()
      return
    }
    setBusy(true)
    note(target ? '保存している…' : '投稿している…')
    try {
      if (target) {
        await api('entry', jsonOpts('POST', { date: hereDay, time: target.time, text }))
        reloadAt(target.id)
      } else {
        const body = await api('post', jsonOpts('POST', { text }))
        const id = body.time.replace(':', '-')
        if (body.date === hereDay) reloadAt(id)
        else location.assign(body.url + '#' + id)
      }
      el.text.value = ''
      dlg.close()
    } catch (e) {
      note(e.message, 'ng')
      setBusy(false)
    }
  }

  // 一度目で身構えて、二度目で消す（_write と同じ）
  async function remove() {
    if (busy || !target) return
    if (!armed) {
      armed = true
      el.del.textContent = '本当に削除'
      el.del.classList.add('is-armed')
      note(`${target.time} を削除する。取り消せない`, 'warn')
      return
    }
    setBusy(true)
    note('削除している…')
    try {
      await api('entry', jsonOpts('DELETE', { date: hereDay, time: target.time }))
      // 消したあとの行き先。同じ日に他のブロックが残っていれば読み直す。
      // 残っていなければ日ページごと無くなるので、まだ記述のある月へ、それも無ければ / へ。
      if (segs.length > 1) {
        reloadAt('')
        return
      }
      const days = await fetch('/days.json').then((r) => r.json()).catch(() => [])
      const month = hereDay.slice(0, 7)
      location.assign(days.some((d) => d.startsWith(month)) ? `/${month.replace('-', '/')}/` : '/')
    } catch (e) {
      note(e.message, 'ng')
      disarm()
      setBusy(false)
    }
  }

  /* ---------------- 操作 ---------------- */

  fab.addEventListener('click', () => open(null))
  el.close.addEventListener('click', () => dlg.close())
  el.submit.addEventListener('click', submit)
  el.del.addEventListener('click', remove)
  dlg.addEventListener('click', (e) => {
    // 覆いの外で閉じる。検索・日付ジャンプと同じ作法
    if (e.target === dlg && !busy) dlg.close()
  })
  dlg.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault()
  })
  dlg.addEventListener('close', disarm)
  dlg.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return
    // ⌘Enter はどちらの状態でも実行。⌘S は保存のときだけ（新規で押してもブラウザの保存は出さない）
    if (e.key === 'Enter' || e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (e.key === 'Enter' || target) submit()
    }
  })

  // 開いているあいだは検索（/ ⌘K）と日付ジャンプ（d）を出さない。
  // 本文欄に焦点があるときは向こうが無視するが、ボタンに焦点があるときは重なって開いてしまう。
  // capture で先に止める。本文欄への入力は止めない（止めると文字が打てなくなる）。
  document.addEventListener('keydown', (e) => {
    if (!dlg.open || e.target === el.text) return
    const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
    if (cmdK || e.key === '/' || e.key === 'd') e.stopPropagation()
  }, true)
})()
