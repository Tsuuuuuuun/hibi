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

  /* ---------------- トーストと同期 ---------------- */

  // 書いたあとは自動では公開せず、トーストの「同期」で一拍おく（書き損じがそのまま上がるのを避ける）。
  // 投稿・保存・削除のあとはページを読み直すので、何をしたかを sessionStorage に残してから移り、
  // 読み込み後に拾って出す。同期が通るか × で閉じるまで残るので、押し忘れても次に開いたときに気付ける。
  // このタブの中だけの話なので localStorage ではなく sessionStorage。_write から同期したぶんは知らない。
  const UNSYNCED = 'hibi:unsynced'
  const session = {
    get: () => { try { return sessionStorage.getItem(UNSYNCED) } catch { return null } },
    set: (v) => { try { sessionStorage.setItem(UNSYNCED, v) } catch {} },
    del: () => { try { sessionStorage.removeItem(UNSYNCED) } catch {} },
  }
  const mark = (msg) => session.set(msg)

  const toast = document.createElement('div')
  toast.className = 'edit-toast'
  toast.setAttribute('role', 'status')
  toast.hidden = true
  toast.innerHTML =
    '<span class="edit-toast-msg"></span>' +
    '<button type="button" class="edit-sync">同期</button>' +
    '<button type="button" class="edit-toast-close" aria-label="閉じる">×</button>'
  document.body.append(toast)
  const tm = toast.querySelector('.edit-toast-msg')
  const syncBtn = toast.querySelector('.edit-sync')
  let hideTimer = null

  const showToast = (msg, kind) => {
    clearTimeout(hideTimer)
    tm.textContent = msg
    toast.className = 'edit-toast' + (kind ? ' is-' + kind : '')
    toast.hidden = false
  }
  const hideToast = () => {
    clearTimeout(hideTimer)
    toast.hidden = true
  }

  // POST /_write/deploy は出力を一行ずつ流し、最後の一行だけが結果（--- ok / --- ng）。_write と同じ読み方。
  async function sync() {
    if (syncBtn.disabled) return
    syncBtn.disabled = true
    syncBtn.textContent = '同期している…'
    showToast('はじめている…')
    let last = ''
    let ok = false
    try {
      const res = await fetch('/_write/deploy', { method: 'POST' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status} ${res.statusText}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let rest = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        rest += decoder.decode(value, { stream: true })
        const parts = rest.split('\n')
        rest = parts.pop()
        for (const line of parts) {
          if (line.startsWith('--- ')) { ok = line.trim() === '--- ok'; continue }
          if (!line.trim()) continue
          last = line
          showToast(line)
        }
      }
      if (!ok) throw new Error(last || '同期に失敗した')
      session.del()
      syncBtn.hidden = true
      showToast(`同期した（${new Date().toTimeString().slice(0, 5)}）`, 'ok')
      hideTimer = setTimeout(hideToast, 4000)
    } catch (e) {
      showToast(`同期に失敗した: ${e.message}`, 'ng')
      syncBtn.disabled = false
      syncBtn.textContent = 'もう一度'
    }
  }

  syncBtn.addEventListener('click', sync)
  toast.querySelector('.edit-toast-close').addEventListener('click', () => {
    session.del()
    hideToast()
  })
  // 読み直したあとに、直前にしたことを拾って出す
  const pending = session.get()
  if (pending) showToast(pending)

  // ここから下は日ページだけ。トーストは月一覧（最後のブロックを消したあとに着く）にも出したいので、上に置いてある。
  if (!hereDay) return

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
    // 新規では見出しの日付と時刻を選べる（触らなければサーバの時計で決まる）。編集では対象の時刻を出すだけ
    '<div class="edit-head"><span class="edit-time"></span>' +
    '<input type="date" class="edit-day" aria-label="投稿する日付" hidden>' +
    '<input type="time" class="edit-when" aria-label="投稿する時刻" hidden>' +
    '<span class="edit-note" aria-live="polite"></span>' +
    '<button type="button" class="edit-draft" hidden>下書きを使う</button></div>' +
    '<textarea class="edit-text" rows="6" placeholder="いま思ったこと" autocapitalize="off"></textarea>' +
    // 本文欄の下に道具の列。写真と、@ で始まる記法を一つずつ（中身は下の TOOLS から組む）
    '<div class="edit-tools" role="toolbar" aria-label="挿入"></div>' +
    '<div class="edit-foot">' +
    '<span class="edit-left"><button type="button" class="edit-close">閉じる</button>' +
    '<button type="button" class="edit-delete" hidden>削除</button></span>' +
    '<button type="button" class="edit-submit">投稿</button>' +
    '</div>' +
    // iOS では写真ピッカーが開き、カメラを選べばそのまま撮れる。JPEG と PNG だけ（build.mjs が寸法を読めるもの）
    '<input type="file" class="edit-file" accept="image/jpeg,image/png" multiple hidden>' +
    '</form>'
  document.body.append(fab, dlg)

  const el = {
    time: dlg.querySelector('.edit-time'),
    day: dlg.querySelector('.edit-day'),
    when: dlg.querySelector('.edit-when'),
    note: dlg.querySelector('.edit-note'),
    draft: dlg.querySelector('.edit-draft'),
    text: dlg.querySelector('.edit-text'),
    close: dlg.querySelector('.edit-close'),
    tools: dlg.querySelector('.edit-tools'),
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
  // 新規の日付・時刻を手で変えたか。変えていないほうは送らず、サーバの時計に任せる
  let dayTouched = false
  let whenTouched = false
  let clockTimer = null

  const today = () => {
    const d = new Date()
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  // 触られていないあいだは、見出しの日付と時刻を今に合わせ続ける（開いたまま置いても古いままにならない）
  const followClock = () => {
    clearInterval(clockTimer)
    clockTimer = setInterval(() => {
      if (!dlg.open || target || (dayTouched && whenTouched)) return clearInterval(clockTimer)
      if (!dayTouched) el.day.value = today()
      if (!whenTouched) el.when.value = clock()
    }, 15000)
  }

  const note = (msg, kind) => {
    el.note.textContent = msg
    el.note.className = 'edit-note' + (kind ? ' is-' + kind : '')
  }
  const setBusy = (on) => {
    busy = on
    el.submit.disabled = on
    el.del.disabled = on
    for (const b of el.tools.querySelectorAll('button')) b.disabled = on
  }
  const disarm = () => {
    armed = false
    el.del.textContent = '削除'
    el.del.classList.remove('is-armed')
  }

  /* ---------------- 下書き ---------------- */

  // 入力のたびに localStorage へ書く。スマホは通知やアプリの切り替えで中断されるので、これが無いと書きかけが消える。
  // キーは対象ごと。新規は hibi:draft:new、編集は hibi:draft:YYYY-MM-DD:HH-MM。
  const draftKey = () => (target ? `hibi:draft:${hereDay}:${target.id}` : 'hibi:draft:new')
  const store = {
    get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
    set: (k, v) => { try { localStorage.setItem(k, v) } catch {} },
    del: (k) => { try { localStorage.removeItem(k) } catch {} },
  }
  const saveDraft = () => {
    if (el.text.value.trim()) store.set(draftKey(), el.text.value)
    else store.del(draftKey())
  }
  const clearDraft = () => store.del(draftKey())

  async function open(id) {
    target = id ? { id, time: id.replace('-', ':') } : null
    disarm()
    note('')
    el.draft.hidden = true
    el.text.value = ''
    el.time.textContent = target ? target.time : ''
    el.time.hidden = !target
    el.day.hidden = el.when.hidden = !!target
    el.day.value = today()
    el.when.value = clock()
    dayTouched = whenTouched = false
    if (!target) followClock()
    el.submit.textContent = target ? '保存' : '投稿'
    el.del.hidden = !target
    dlg.showModal()
    fit()
    el.text.focus()
    const draft = store.get(draftKey())
    if (!target) {
      // 新規なら、残っていた書きかけをそのまま入れる
      if (draft) el.text.value = draft
      return
    }
    // 本文はサーバから読む。読み終わるまで保存も削除もできないようにしておく。
    setBusy(true)
    note('読んでいる…')
    try {
      const { exists, text } = await api(`entry?date=${hereDay}&time=${target.time}`)
      const current = exists ? text.replace(/\s+$/, '') : ''
      el.text.value = current
      note(exists ? '' : 'このファイルはもう無い', 'ng')
      // 書きかけがサーバの本文と食い違うときだけ、どちらを使うか委ねる（同じなら黙って捨てる）
      if (draft && draft.replace(/\s+$/, '') !== current) {
        note('書きかけの下書きがある', 'warn')
        el.draft.hidden = false
      } else if (draft) {
        clearDraft()
      }
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
        mark(`${target.time} を保存した`)
        reloadAt(target.id)
      } else {
        // 手で選んだものだけ送る。input が空（消した）なら選んでいないのと同じ扱い
        const date = dayTouched && /^\d{4}-\d\d-\d\d$/.test(el.day.value) ? el.day.value : undefined
        const time = whenTouched && /^\d\d:\d\d$/.test(el.when.value) ? el.when.value : undefined
        const body = await api('post', jsonOpts('POST', { text, date, time }))
        const id = body.time.replace(':', '-')
        mark(`${body.date === hereDay ? '' : body.date + ' '}${body.time} に投稿した`)
        if (body.date === hereDay) reloadAt(id)
        else location.assign(body.url + '#' + id)
      }
      clearDraft()
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
      mark(`${target.time} を削除した`)
      clearDraft()
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

  /* ---------------- 挿入 ---------------- */

  // 写真も @ の記法も一つで一つのブロックになるので、前後を空行で挟んで入れる（_write と同じ）。
  // 入れる位置は選択の終わり。選んであった文字は消さない（consume を立てたときだけ s に置き換える）。
  // from/to を渡せば、入れたあとに s の中のその範囲を選んでおく
  // （仮の文字を入れて選んでおき、そのまま貼り付けか打ち込みで埋めてもらうため）。省けば s の直後に置く。
  function insertBlock(s, { from = s.length, to = from, consume = false } = {}) {
    const t = el.text
    const start = consume ? t.selectionStart : t.selectionEnd
    const before = t.value.slice(0, start).replace(/\n+$/, '')
    const after = t.value.slice(t.selectionEnd).replace(/^\n+/, '')
    t.value = (before ? before + '\n\n' : '') + s + (after ? '\n\n' + after : '\n')
    const base = before ? before.length + 2 : 0
    t.setSelectionRange(base + from, base + to)
    t.focus()
    saveDraft()
  }

  // 本文欄の下に並ぶ道具。@ の記法は覚えにくいので、押せば雛形が入るようにしてある（記法は README の記法一覧）。
  // 埋める所（URL や場所の名前）は仮の文字で入れて選んでおくので、そのまま貼り付ければよい。
  // 本文欄で URL などを選んでから押せば、仮の文字の代わりにそれが入る（貼ってから形にする使い方）。
  // 読み上げと title に記法そのものも書いておき、覚える手がかりにする。
  const ICON = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`
  const TOOLS = [
    { key: 'photo', label: '写真を添付',
      icon: ICON('<rect x="1.8" y="3" width="12.4" height="10" rx="1.6"/><circle cx="5.6" cy="6.3" r="1.2"/><path d="M2.4 12.2 6.4 8.4l2.5 2.3 2-1.8 2.8 2.7"/>') },
    { key: 'link', label: 'リンクカード（@link URL）', tpl: '@link URL', pick: 'URL',
      icon: ICON('<path d="M6.6 9.4 9.4 6.6"/><path d="M7.3 4.7l1.3-1.3a2.7 2.7 0 0 1 3.8 3.8L11.1 8.5"/><path d="M8.7 11.3l-1.3 1.3a2.7 2.7 0 0 1-3.8-3.8l1.3-1.3"/>') },
    { key: 'youtube', label: 'YouTube（@youtube URL）', tpl: '@youtube URL', pick: 'URL',
      icon: ICON('<rect x="1.8" y="3.4" width="12.4" height="9.2" rx="2.4"/><path d="M6.7 5.9v4.2L10.3 8Z"/>') },
    { key: 'x', label: 'X のポスト（@x URL）', tpl: '@x URL', pick: 'URL',
      icon: ICON('<path d="M3.6 3 12.4 13"/><path d="M12.4 3 3.6 13" stroke-width=".9"/>') },
    { key: 'music', label: 'Apple Music（@music URL）', tpl: '@music URL', pick: 'URL',
      icon: ICON('<path d="M6 12.3V3.7l6-1.3v8.5"/><circle cx="4.2" cy="12.3" r="1.8"/><circle cx="10.2" cy="10.9" r="1.8"/>') },
    { key: 'map', label: '場所（@map 場所 | 地図のリンク）', tpl: '@map 場所', pick: '場所',
      icon: ICON('<path d="M8 1.5a4.5 4.5 0 0 1 4.5 4.5c0 3.3-4.5 8.5-4.5 8.5S3.5 9.3 3.5 6A4.5 4.5 0 0 1 8 1.5Z"/><circle cx="8" cy="6" r="1.6"/>') },
    { key: 'add', label: '追記（@追記 日付）',
      icon: ICON('<path d="M2.5 4h8.5"/><path d="M2.5 7.5h8.5"/><path d="M2.5 11h5"/><path d="M12 8.5v5"/><path d="M9.5 11h5"/>') },
  ]
  el.tools.innerHTML = TOOLS.map((tool, i) =>
    (i === 1 ? '<span class="edit-tools-sep" aria-hidden="true"></span>' : '') +
    `<button type="button" class="edit-tool" data-tool="${tool.key}" aria-label="${tool.label}" title="${tool.label}">${tool.icon}</button>`
  ).join('')

  // 本文欄で選んである一行があれば、それを埋めるものとして使う
  const selection = () => {
    const sel = el.text.value.slice(el.text.selectionStart, el.text.selectionEnd).trim()
    return sel && !/\n/.test(sel) ? sel : ''
  }

  function insertDirective(tool) {
    const sel = selection()
    if (sel) return insertBlock(tool.tpl.replace(tool.pick, sel), { consume: true })
    const at = tool.tpl.indexOf(tool.pick)
    insertBlock(tool.tpl, { from: at, to: at + tool.pick.length })
  }

  // 追記。書いている日が今日でなければ今日の日付を付け（後から足したと分かる）、本文は次の行から。
  // 今日なら日付は要らないので、「@追記 」に続けてそのまま書く。選んであった文字は一段落目になる。
  function insertAddendum() {
    const sel = selection()
    const day = target ? hereDay : el.day.value || today()
    const consume = !!sel
    if (day === today()) return insertBlock('@追記 ' + sel, { consume })
    const d = new Date()
    insertBlock(`@追記 ${pad(d.getMonth() + 1)}.${pad(d.getDate())}\n` + sel, { consume })
  }

  el.tools.addEventListener('click', (e) => {
    const b = e.target.closest('.edit-tool')
    if (!b || busy) return
    const tool = TOOLS.find((t) => t.key === b.dataset.tool)
    if (tool.key === 'photo') el.file.click()
    else if (tool.key === 'add') insertAddendum()
    else insertDirective(tool)
  })

  /* ---------------- 写真 ---------------- */

  const imagesOf = (list) => [...list].filter((f) => f && /^image\/(jpeg|png)$/.test(f.type))

  async function upload(files) {
    if (busy || !files.length) return
    setBusy(true)
    try {
      for (const [i, file] of files.entries()) {
        note(files.length > 1 ? `写真を置いている…（${i + 1}/${files.length}）` : '写真を置いている…')
        // 名前はサーバが貼った日時で振り、置き先は R2 で記事の日には依らないので、送るのは中身だけ
        const res = await api('image', {
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

  /* ---------------- ソフトキーボード ---------------- */

  // iOS ではソフトキーボードが出ても固定した要素は押し上げられず、下段のボタンがキーボードの下に隠れる。
  // visualViewport の高さと位置に合わせて、一段組のあいだだけシートの下端と高さを可視領域に揃える。
  // キーボードが出ているあいだ（可視領域が窓より明らかに低い）は、可視領域いっぱいの高さにする。
  const narrow = matchMedia('(max-width: 680px)')
  const vv = window.visualViewport
  function fit(view = vv) {
    if (!dlg.open || !view || !narrow.matches) {
      dlg.style.removeProperty('--vv-h')
      dlg.style.removeProperty('--vv-b')
      dlg.classList.remove('is-keyboard')
      return
    }
    const bottom = Math.max(0, window.innerHeight - (view.offsetTop + view.height))
    dlg.style.setProperty('--vv-h', `${Math.round(view.height)}px`)
    dlg.style.setProperty('--vv-b', `${Math.round(bottom)}px`)
    dlg.classList.toggle('is-keyboard', view.height < window.innerHeight - 120)
  }
  const refit = () => fit()
  if (vv) {
    vv.addEventListener('resize', refit)
    vv.addEventListener('scroll', refit)
  }
  narrow.addEventListener('change', refit)
  dlg.__fit = fit   // 試験用。偽の可視領域を渡して寸法を検算する

  /* ---------------- 操作 ---------------- */

  fab.addEventListener('click', () => open(null))
  // 「n」で新規を開く（Twitter と同じ）。作法は日付ジャンプの「d」（assets/jump.js）に揃える。
  // この script 自体が日ページにしか走らないので、拾うのは「＋」が出ているページだけ。
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return
    if (document.querySelector('dialog[open]')) return
    const t = e.target
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
    e.preventDefault()
    open(null)
  })
  el.close.addEventListener('click', () => dlg.close())
  el.text.addEventListener('input', saveDraft)
  el.draft.addEventListener('click', () => {
    el.text.value = store.get(draftKey()) || ''
    el.draft.hidden = true
    note('')
    el.text.focus()
  })
  dlg.addEventListener('close', refit)
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
  dlg.addEventListener('close', () => clearInterval(clockTimer))
  for (const type of ['input', 'change']) {
    el.day.addEventListener(type, () => { dayTouched = true })
    el.when.addEventListener(type, () => { whenTouched = true })
  }
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
