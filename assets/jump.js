// 日付で移る覆い。ページに出ているのは末尾の「日付」一語だけで、押すとその月のカレンダーが出る。
// 記述のある日だけが押せて、無い日は薄いまま動かない。
// 日の一覧は /days.json（日付だけの小さな配列）を最初に開いたときに一度だけ読む。
// 覆いの体裁も閉じ方も、呼び出しの鍵があることも、検索（assets/search.js）に揃えてある。
// ボタンは hidden にしてあり、動かせるときだけ出す（開けない一語をページに残さない）。
(() => {
  const trigger = document.querySelector('.jump-open');
  const dlg = document.querySelector('dialog.jump');
  if (!trigger || !dlg || !dlg.showModal || !window.fetch) return;
  const title = dlg.querySelector('.jump-title');
  const grid = dlg.querySelector('.jump-grid');
  const prev = dlg.querySelector('.jump-prev');
  const next = dlg.querySelector('.jump-next');
  trigger.hidden = false;

  // 中黒は二語とも出たときだけ引く。どちらの script が後に走っても同じ結果になるよう両方から見る。
  const sep = document.querySelector('.foot-sep');
  const other = document.querySelector('.search-open');
  if (sep && other && !other.hidden) sep.hidden = false;

  const DOW = ['日', '月', '火', '水', '木', '金', '土'];

  // 今いる日と月。canonical から取る（/ は最新の日ページの写しで、パスからは日が読めない）。
  const canon = document.head.querySelector('link[rel="canonical"]')?.getAttribute('href');
  const here = new URL(canon || location.href, location.href).pathname;
  const hereDay = here.match(/^\/(\d{4})\/(\d{2})\/(\d{2})\/$/)?.slice(1).join('-') || '';
  const hereMonth = hereDay.slice(0, 7) || here.match(/^\/(\d{4})\/(\d{2})\/$/)?.slice(1).join('-') || '';

  let days = null;    // 記述のある日（Set）
  let months = [];    // 記述のある月。暦順
  let cur = '';
  let loading = null;
  const load = () => loading || (loading = fetch('/days.json')
    .then(r => r.json())
    .then(list => {
      days = new Set(list);
      months = [...new Set(list.map(d => d.slice(0, 7)))];
    })
    .catch(() => { days = new Set(); months = []; }));

  function render() {
    const mi = months.indexOf(cur);
    prev.disabled = mi <= 0;
    next.disabled = mi < 0 || mi >= months.length - 1;
    title.textContent = `${+cur.slice(0, 4)}年${+cur.slice(5, 7)}月`;
    title.href = `/${cur.replace('-', '/')}/`; // 月の見出しはその月の一覧へのリンク

    const [y, m] = cur.split('-').map(Number);
    const lead = new Date(y, m - 1, 1).getDay();  // その月の 1 日の曜日
    const last = new Date(y, m, 0).getDate();     // 前月の 0 日 = その月の末日
    let html = DOW.map(d => `<span class="jump-dow">${d}</span>`).join('');
    html += '<span class="d"></span>'.repeat(lead);
    for (let d = 1; d <= last; d++) {
      const iso = `${cur}-${String(d).padStart(2, '0')}`;
      html += days.has(iso)
        ? `<a${iso === hereDay ? ' class="is-here"' : ''} href="/${iso.replaceAll('-', '/')}/">${d}</a>`
        : `<span class="d">${d}</span>`;
    }
    grid.innerHTML = html;
  }

  // 月の繰りは記述のある月だけを辿る（下の「前の月」「次の月」と同じ。空の月は出さない）
  const step = n => {
    const to = months[months.indexOf(cur) + n];
    if (!to) return;
    // 焦点が日の上にあったなら、描き直しで消える。新しい月の最初の日に置き直す。
    const held = grid.contains(document.activeElement);
    cur = to;
    render();
    if (held) grid.querySelector('a')?.focus();
  };

  function open() {
    if (dlg.open) return;
    dlg.showModal();
    load().then(() => {
      if (!months.length) return;
      cur = months.includes(hereMonth) ? hereMonth : months[months.length - 1];
      render();
      // 既定では最初の焦点が「‹」に乗って枠が浮く。今いる日（無ければその月の最後の日）に移す。
      // 月を繰るときは焦点をそのまま「‹」「›」に残すので、ここでしかやらない。
      const days = [...grid.querySelectorAll('a')];
      (grid.querySelector('a.is-here') || days[days.length - 1] || prev).focus();
    });
  }

  trigger.addEventListener('click', open);
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));

  // 覆いの外（backdrop）を押したら閉じる。Esc は dialog 自身が閉じる
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  // 出ているあいだは「←」「→」で月を繰り、出ていないときは「d」で開く。
  // どちらも document で拾う。dialog に付けると、月を繰ったあとに焦点の乗っていた日が
  // 描き直しで消え、そこから先のキーが dialog まで上がってこない。
  document.addEventListener('keydown', e => {
    if (dlg.open) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      step(e.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    // 文字を打っている最中と、別の覆いが出ているときは拾わない
    if (e.key !== 'd' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    e.preventDefault();
    open();
  });
})();
