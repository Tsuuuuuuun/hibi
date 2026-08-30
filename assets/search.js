// 検索。ページに出ているのは末尾の「検索」一語だけで、押すか「/」で覆い（dialog）が開く。
// /search.json を一度だけ読み、絞り込みはブラウザ側でやる。
// 動かせないブラウザではボタンを出さない（hidden のまま）ので、引けない窓は残らない。
(() => {
  const trigger = document.querySelector('.search-open');
  const dlg = document.querySelector('dialog.search');
  if (!trigger || !dlg || !dlg.showModal || !window.fetch) return;
  const input = dlg.querySelector('.search-input');
  const panel = dlg.querySelector('.search-panel');
  trigger.hidden = false;

  // 中黒は二語とも出たときだけ引く。どちらの script が後に走っても同じ結果になるよう両方から見る。
  const sep = document.querySelector('.foot-sep');
  const other = document.querySelector('.jump-open');
  if (sep && other && !other.hidden) sep.hidden = false;

  const MAX = 40;     // 出す件数の上限
  const BEFORE = 24;  // 抜粋で当たりの前に残す文字数
  const LEN = 90;     // 抜粋の長さ
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];

  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // 表記のゆれを畳む（全角半角・大文字小文字・カタカナひらがな）。
  // 一文字ずつ、長さを変えないように畳む。元の文と位置がずれると抜粋と強調の位置が合わなくなる。
  const kana = c => c >= 'ァ' && c <= 'ヶ' ? String.fromCharCode(c.charCodeAt(0) - 0x60) : c;
  const norm = s => Array.from(s).map(c => {
    const n = kana(c.normalize('NFKC').toLowerCase());
    return n.length === c.length ? n : c;
  }).join('');

  let rows = null;
  let loading = null;
  const load = () => loading || (loading = fetch('/search.json')
    .then(r => r.json())
    .then(list => { rows = list.map(r => ({ d: r.d, t: r.t, n: norm(r.t) })); })
    .catch(() => { rows = []; }));

  // 最初に当たった位置の前後を切り出し、その範囲の中の当たりをすべて包む
  function snippet(row, terms) {
    let at = row.n.length;
    for (const t of terms) {
      const i = row.n.indexOf(t);
      if (i >= 0 && i < at) at = i;
    }
    const from = Math.max(0, at - BEFORE);
    const text = row.t.slice(from, from + LEN);
    const flat = row.n.slice(from, from + LEN);

    const spans = [];
    for (const t of terms) {
      for (let i = flat.indexOf(t); i >= 0; i = flat.indexOf(t, i + t.length)) spans.push([i, i + t.length]);
    }
    spans.sort((a, b) => a[0] - b[0]);

    let out = '';
    let pos = 0;
    for (const [s, e] of spans) {
      if (s < pos) continue; // 重なった当たりは先のものを優先
      out += esc(text.slice(pos, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>';
      pos = e;
    }
    out += esc(text.slice(pos));
    return (from > 0 ? '…' : '') + out + (from + LEN < row.t.length ? '…' : '');
  }

  function hitHtml(row, terms) {
    const [y, m, d] = row.d.split('-').map(Number);
    const dow = DOW[new Date(y, m - 1, d).getDay()];
    return `<a class="hit" href="/${row.d.replaceAll('-', '/')}/">` +
      `<span class="hit-date">${row.d.replaceAll('-', '.')}<span class="hit-dow">${dow}</span></span>` +
      `<span class="hit-text">${snippet(row, terms)}</span></a>`;
  }

  function render() {
    // 打ち込みのほうは位置を気にしないので、先に普通の NFKC も掛ける（半角の「ﾊﾞ」を「バ」に畳むため）
    const terms = norm(input.value.normalize('NFKC')).split(/\s+/).filter(Boolean);
    if (!terms.length || !rows) { clear(); return; }

    const hits = rows.filter(r => terms.every(t => r.n.includes(t)));
    panel.innerHTML = hits.length
      ? `<p class="search-count">${hits.length}件${hits.length > MAX ? `（上から${MAX}件）` : ''}</p>` +
        hits.slice(0, MAX).map(r => hitHtml(r, terms)).join('')
      : `<p class="search-count">見つからない</p>`;
    panel.hidden = false;
    panel.scrollTop = 0;
  }

  function clear() {
    panel.hidden = true;
    panel.innerHTML = '';
  }

  function open() {
    if (dlg.open) { input.select(); return; }
    dlg.showModal();
    input.focus();
    input.select();
    load().then(() => { if (input.value.trim()) render(); });
  }

  const hits = () => [...panel.querySelectorAll('.hit')];
  function move(step) {
    const list = hits();
    if (!list.length) return;
    const now = list.findIndex(a => a.classList.contains('is-on'));
    const next = list[Math.max(0, Math.min(list.length - 1, now < 0 ? (step > 0 ? 0 : list.length - 1) : now + step))];
    list.forEach(a => a.classList.toggle('is-on', a === next));
    next.scrollIntoView({ block: 'nearest' });
  }

  trigger.addEventListener('click', open);
  input.addEventListener('input', () => { load().then(render); });

  // 覆いの外（backdrop）を押したら閉じる。Esc は dialog 自身が閉じる
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (panel.hidden) return;
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      const go = panel.querySelector('.hit.is-on') || panel.querySelector('.hit');
      if (go) { e.preventDefault(); location.href = go.href; }
    } else if (e.key === 'Escape') {
      // type="search" の入力欄が Esc を食べてしまい、dialog 自身の取り消しまで届かない
      e.preventDefault();
      dlg.close();
    }
  });

  // どこからでも「/」か ⌘K で開く（文字を打っている最中は拾わない）
  document.addEventListener('keydown', e => {
    const cmdK = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k';
    const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (!cmdK && !slash) return;
    const t = e.target;
    if (!dlg.open && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!dlg.open && document.querySelector('dialog[open]')) return; // 別の覆いが出ているときは拾わない
    e.preventDefault();
    open();
  });
})();
