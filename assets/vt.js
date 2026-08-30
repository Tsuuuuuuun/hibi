// 一覧（月ページ）と日ページのあいだの遷移。
// 同じ日の「日付」と「本文」は両方のページに同じ形・同じ大きさで出るので、その二つにだけ
// view-transition-name を付けて、位置を動かす。残りの記事や上下の飾りは root の交差フェードに任せる。
// 名前を付けるのは一ページにつき一記事だけなので、日付ごとに名前を変える必要はない。
// 動かす相手を CSS では選べない（どの日へ行くのかはそのときの操作で決まる）ので、ここで選ぶ。
// このファイルは defer で読まない。pagereveal は最初の描画のときに飛んでくるので、
// 解析の終わりまで待つと登録が間に合わないことがある。
(() => {
  if (!('startViewTransition' in document)) return;

  // 動かす相手。日付・その下の時刻・本文の三つで、どれも両方のページに同じ形で出る。
  // 「一覧へ」は同じページの中のジャンプのときだけ（月ページには無いので、そこでは見つからない）。
  const NAMES = [
    ['.datelink', 'day-date'],
    ['.times', 'day-times'],
    ['.body', 'day-body'],
    ['.back', 'day-back'],
  ];
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

  // 同じページの中の時刻ジャンプ（日ページの、日付の下の時刻）。
  // ページを移るときと同じ二つ（日付と本文）に名前を付けて、同じ動きで移す。
  // 日付は貼り付いているので位置が変わらず、動くのは本文だけになる。
  addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('.times a[href^="#"]');
    if (!a || reduce.matches) return;
    if (!document.getElementById(decodeURIComponent(a.hash.slice(1)))) return; // 飛び先が無ければ既定に任せる
    e.preventDefault();
    // 名前は写しを取る前に付ける（startViewTransition を呼んだ時点で古い側が写る）
    const clear = mark(a.closest('.wrap'));  // 「一覧へ」も動く（記事の外にあるので囲いから探す）
    // hash を書き換えると履歴にも残る（戻るで元の位置に戻れる）。位置はその場で移り、写しに入る。
    const vt = document.startViewTransition(() => { location.hash = a.hash; });
    // 途中で別のページへ移ると遷移は飛ばされる。ready は捨てておかないと未処理の拒否になる。
    vt.ready.catch(() => {});
    if (clear) vt.finished.then(clear, clear);
  });
})();
