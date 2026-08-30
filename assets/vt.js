// 一覧（月ページ）と日ページのあいだの遷移。
// 同じ日の「日付」と「本文」は両方のページに同じ形・同じ大きさで出るので、その二つにだけ
// view-transition-name を付けて、位置を動かす。残りの記事や上下の飾りは root の交差フェードに任せる。
// 名前を付けるのは一ページにつき一記事だけなので、日付ごとに名前を変える必要はない。
// 動かす相手を CSS では選べない（どの日へ行くのかはそのときの操作で決まる）ので、ここで選ぶ。
// このファイルは defer で読まない。pagereveal は最初の描画のときに飛んでくるので、
// 解析の終わりまで待つと登録が間に合わないことがある。
(() => {
  if (!('startViewTransition' in document)) return;

  const NAMES = [['.datelink', 'day-date'], ['.body', 'day-body']];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  // /2026/08/30/ → 2026-08-30。月ページや 404 は null。
  // / は最新の日ページの写しなので、パスからは日が読めない。どの日かは head の home-day から取る。
  const HOME = document.head.querySelector('meta[name="home-day"]')?.content || '';
  const dayOf = url => {
    if (!url) return null;
    const p = new URL(url, location.href).pathname;
    if (p === '/') return HOME || null;
    const m = p.match(/^\/(\d{4})\/(\d{2})\/(\d{2})\/$/);
    return m ? m.slice(1).join('-') : null;
  };

  const onScreen = el => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight;
  };

  // 行き先（または来た先）と今のページのどちらかが日ページで、その日の記事がこのページに出ていて、
  // かつ画面の中にあるときだけ動かす。遠くにいる記事を動かすと画面の外へ飛んでいくだけになる。
  //
  // 一覧に入っていくときは、来た日の記事が画面の外にいたらそこまで送ってから測る。
  // 「一覧へ」は一覧の先頭に着くので、月の下の方の日はそのままだと必ず画面の外にいて動かせない。
  // 送っておけば戻るボタンと同じ位置に着き、動きも同じになる（戻るボタンは位置が復元されるので送らない）。
  function pick(otherUrl, arriving) {
    const day = dayOf(otherUrl) || dayOf(location.href);
    const el = day && document.querySelector(`article[data-day="${day}"]`);
    if (!el) return null;
    if (arriving && dayOf(otherUrl) && !onScreen(el)) el.scrollIntoView();
    return onScreen(el) ? el : null;
  }

  // 付けた名前は残さない（view-transition-name は包含のふるまいを変えるので、遷移が終わったら外す）
  function mark(el) {
    if (!el) return null;
    const marked = [];
    for (const [sel, name] of NAMES) {
      const node = el.querySelector(sel);
      if (node) { node.style.viewTransitionName = name; marked.push(node); }
    }
    return marked.length ? () => marked.forEach(n => { n.style.viewTransitionName = ''; }) : null;
  }

  const setup = (vt, otherUrl, arriving) => {
    if (!vt) return;
    if (reduce.matches) return vt.skipTransition();
    const clear = mark(pick(otherUrl, arriving));
    if (clear) vt.finished.then(clear, clear);
  };

  // 出ていく側。写しを取る直前に呼ばれるので、ここで付ければその名前で写る。
  addEventListener('pageswap', e => setup(e.viewTransition, e.activation?.entry?.url, false));
  // 入る側。最初の描画の前に呼ばれるので、ここで送った位置がそのまま写る。
  addEventListener('pagereveal', e => setup(e.viewTransition, window.navigation?.activation?.from?.url, true));
})();
