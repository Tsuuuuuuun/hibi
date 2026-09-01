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
    '<button type="button" class="edit-photo">写真</button>' +
    '<button type="button" class="edit-delete" hidden>削除</button></span>' +
    '<button type="button" class="edit-submit">投稿</button>' +
    '</div>' +
    // iOS では写真ピッカーが開き、カメラを選べばそのまま撮れる。JPEG と PNG だけ（build.mjs が寸法を読めるもの）
    '<input type="file" class="edit-file" accept="image/jpeg,image/png" multiple hidden>' +
    '</form>'
  document.body.append(fab, dlg)

  const el = {
    time: dlg.querySelector('.edit-time'),
    note: dlg.querySelector('.edit-note'),
    text: dlg.querySelector('.edit-text'),
    close: dlg.querySelector('.edit-close'),
    photo: dlg.querySelector('.edit-photo'),
    file: dlg.querySelector('.edit-file'),
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
    el.photo.disabled = on
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

  /* ---------------- 写真 ---------------- */

  // 写真は一枚で一つの図になるので、前後を空行で挟んだ一行として入れる（_write と同じ）
  function insertBlock(s) {
    const t = el.text
    const before = t.value.slice(0, t.selectionStart).replace(/\n+$/, '')
    const after = t.value.slice(t.selectionEnd).replace(/^\n+/, '')
    t.value = (before ? before + '\n\n' : '') + s + (after ? '\n\n' + after : '\n')
    const pos = (before ? before.length + 2 : 0) + s.length
    t.setSelectionRange(pos, pos)
    t.focus()
  }

  // 置き先の日。編集なら対象の日、新規なら今日（実際の書き込み先はサーバが決めるが、
  // 日付をまたぐ瞬間に入れた写真だけ本文と別の日に置かれうる。稀なので初版では扱わない）。
  const photoDate = () => {
    if (target) return hereDay
    const d = new Date()
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  const imagesOf = (list) => [...list].filter((f) => f && /^image\/(jpeg|png)$/.test(f.type))

  async function upload(files) {
    if (busy || !files.length) return
    setBusy(true)
    try {
      for (const [i, file] of files.entries()) {
        note(files.length > 1 ? `写真を置いている…（${i + 1}/${files.length}）` : '写真を置いている…')
        // ファイル名はサーバが時刻で振るので、送るのは中身だけ
        const res = await api(`image?date=${photoDate()}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: await file.arrayBuffer(),
        })
        insertBlock(`![](${res.ref})`)
      }
      note('')
    } catch (e) {
      note(e.message, 'ng')
    } finally {
      setBusy(false)
      el.file.value = ''
    }
  }

  el.photo.addEventListener('click', () => el.file.click())
  el.file.addEventListener('change', () => upload(imagesOf(el.file.files)))
  // デスクトップではドラッグ＆ドロップと貼り付けも受ける
  for (const type of ['dragenter', 'dragover']) {
    el.text.addEventListener(type, (e) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      dlg.classList.add('is-dropping')
    })
  }
  for (const type of ['dragleave', 'dragend', 'drop']) {
    el.text.addEventListener(type, () => dlg.classList.remove('is-dropping'))
  }
  el.text.addEventListener('drop', (e) => {
    const files = imagesOf(e.dataTransfer.files)
    if (!files.length) return
    e.preventDefault()
    upload(files)
  })
  el.text.addEventListener('paste', (e) => {
    const files = imagesOf([...e.clipboardData.items].map((i) => i.getAsFile()))
    if (!files.length) return
    e.preventDefault()
    upload(files)
  })

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
