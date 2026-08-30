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
  const dayOf = url => {
    if (!url) return null;
    const m = new URL(url, location.href).pathname.match(/^\/(\d{4})\/(\d{2})\/(\d{2})\/$/);
    return m ? m.slice(1).join('-') : null;
  };

  // 行き先（または来た先）と今のページのどちらかが日ページで、その日の記事がこのページに出ていて、
  // かつ画面の中にあるときだけ動かす。
  // 画面の外まで見るのは、日ページから一覧へ進んだときに月の下の方の日が遠くにいることがあるため。
  // そのときは名前を付けず、ふつうの交差フェードにする。
  function pick(otherUrl) {
    const day = dayOf(otherUrl) || dayOf(location.href);
    const el = day && document.querySelector(`article[data-day="${day}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight ? el : null;
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

  const setup = (vt, otherUrl) => {
    if (!vt) return;
    if (reduce.matches) return vt.skipTransition();
    const clear = mark(pick(otherUrl));
    if (clear) vt.finished.then(clear, clear);
  };

  // 出ていく側。写しを取る直前に呼ばれるので、ここで付ければその名前で写る。
  addEventListener('pageswap', e => setup(e.viewTransition, e.activation?.entry?.url));
  // 入る側。最初の描画の前に呼ばれる。
  addEventListener('pagereveal', e => setup(e.viewTransition, window.navigation?.activation?.from?.url));
})();
