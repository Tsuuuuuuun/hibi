// 静的サイトジェネレータ。content/YYYY/MM/DD/HH-MM.md を読み、site/ に月ページ・日ページ・RSS を生成する。
// 依存なし。`node build.mjs` で一回ビルド、`node build.mjs --watch` で監視ビルド＋確認サーバ。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 既定は content/ → site/。npm run ref は環境変数で別のディレクトリを指す。
const CONTENT = path.resolve(ROOT, process.env.HIBI_CONTENT || 'content');
const OUT = path.resolve(ROOT, process.env.HIBI_OUT || 'site');
let config; // build() のたびに site.config.json から読み直す
let homeDay; // 最新の日。/ はこの日のページと同じ内容になる（assets/vt.js が / を日として読むために head へ出す）

// ログ用。ROOT の外（npm run ref の一時ディレクトリ）は絶対パスのまま出す。
const rel = p => p.startsWith(ROOT + path.sep) ? path.relative(ROOT, p) : p;

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 本文中のリンクは [表示文字](URL) と書く。対応するのはこれだけで、強調やコードはない。
// 置換は esc の後に掛ける。表示文字にも URL にも生の < > " は残らないので、
// リンクの形をした入力から新しいタグが生えることはない。
// 直前が ! のものは写真の記法なので拾わない（写真は行全体で書く）。
// URL の中の () は一段だけ入れ子を許す（Wikipedia の /Foo_(bar) のような形のため）
const INLINE_LINK = /(?<!!)\[([^\]\n]+)\]\(((?:https?:\/\/|\/)(?:[^\s()]|\([^\s()]*\))*)\)/g;
const inline = s => esc(s).replace(INLINE_LINK, (_, label, href) =>
  href.startsWith('/')
    ? `<a href="${href}">${label}</a>`
    : `<a href="${href}" target="_blank" rel="noopener">${label}</a>`);

/* ---------------- 画像サイズ ---------------- */

// width/height/aspect-ratio を必ず出すため、JPEG/PNG のヘッダから寸法を読む。
const imageSize = file => imageSizeOf(fs.readFileSync(file), file);

function imageSizeOf(buf, label) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  throw new Error(`画像サイズを読めない: ${label}（JPEG/PNG のみ対応）`);
}

/* ---------------- パース ---------------- */

// content/YYYY/MM/DD/HH-MM.md。一ファイルが一つの時刻ブロックで、時刻はファイル名から取る。
function collectEntries() {
  const entries = [];
  for (const y of subdirs(CONTENT, /^\d{4}$/)) {
    for (const m of subdirs(path.join(CONTENT, y), /^\d{2}$/)) {
      for (const d of subdirs(path.join(CONTENT, y, m), /^\d{2}$/)) {
        const dir = path.join(CONTENT, y, m, d);
        const files = fs.readdirSync(dir).filter(f => /^\d{2}-\d{2}\.md$/.test(f)).sort();
        if (!files.length) continue;
        entries.push({
          iso: `${y}-${m}-${d}`,
          segs: files.map(f => parseSegment(path.join(dir, f), f.slice(0, 5).replace('-', ':'))),
        });
      }
    }
  }
  // 暦順（古い日から）。一日の中の時刻が昇順なので、日と日のあいだも同じ向きに揃える。
  // 新着順が要るのは feed と検索だけで、そこは使う側で反転する。
  return entries.sort((a, b) => a.iso.localeCompare(b.iso));
}

function subdirs(dir, re) {
  return fs.readdirSync(dir)
    .filter(f => re.test(f) && fs.statSync(path.join(dir, f)).isDirectory())
    .sort();
}

function parseSegment(file, time) {
  const seg = { time, blocks: [] };
  let block = [];
  const flush = () => {
    if (!block.length) return;
    // 画像だけのブロックは一行につき一つの図になるので、配列で返ってくる
    const parsed = parseBlock(block);
    if (parsed) seg.blocks.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    block = [];
  };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^## \d{2}:\d{2}\s*$/.test(line)) {
      throw new Error(`時刻はファイル名で指定する（${file} に "${line.trim()}" がある）`);
    }
    if (line.trim() === '') { flush(); continue; }
    block.push(line);
  }
  flush();
  return seg;
}

function parseBlock(lines) {
  const first = lines[0];

  if (lines.every(l => /^!\[.*\]\(.+\)$/.test(l))) {
    return lines.map(l => {
      const m = l.match(/^!\[(.*)\]\((.+)\)$/);
      return { type: 'img', cap: m[1], src: m[2] };
    });
  }
  if (first.startsWith('@link ')) {
    // URL だけ書けば OGP から自動取得。手書きのフィールドは取得値より優先。
    const [href, title, desc, site, thumb] = first.slice(6).split('|').map(s => s.trim());
    return { type: 'link', href, manual: { title, desc, site, thumb } };
  }
  if (first.startsWith('@youtube ')) {
    const [id, cap] = first.slice(9).split('|').map(s => s.trim());
    return { type: 'yt', id, cap: cap || '' };
  }
  if (first.startsWith('@music ')) {
    const parts = first.slice(7).split('|').map(s => s.trim());
    // 共有リンク（music.apple.com）をそのまま書けるよう、埋め込み用ホストに変換する
    const url = parts[0].replace(/^https:\/\/music\.apple\.com\//, 'https://embed.music.apple.com/');
    // 曲（?i= 付き）は小さいプレイヤー、アルバム・プレイリストは背の高いプレイヤー
    const isTrack = /[?&]i=\d/.test(url);
    return { type: 'am', url, cap: parts[1] || '', tall: parts.includes('tall') || !isTrack };
  }
  if (/^@(?:x|twitter)\s/i.test(first)) {
    const parts = first.replace(/^@(?:x|twitter)\s+/i, '').split('|').map(s => s.trim());
    const id = tweetId(parts[0]);
    if (!id) throw new Error(`@x にはポストの URL か ID を書く（"${first}" が読めない）`);
    // 手書きの URL はハンドル入り。取得に失敗したときのリンク先として残す
    const href = /^https?:\/\//.test(parts[0]) ? parts[0] : `https://x.com/i/status/${id}`;
    return { type: 'x', id, href, cap: parts[1] || '' };
  }
  if (/^@追記(?:\s|$)/.test(first)) {
    // 日付は省略できる。日付に見えなければ、その行の残りがそのまま一段落目になる
    const rest = first.replace(/^@追記\s*/, '');
    const date = /^\d{1,4}[./-]\d{1,2}(?:[./-]\d{1,2})?$/.test(rest) ? rest : '';
    const head = !date && rest ? [rest] : [];
    return { type: 'add', date, paras: [...head, ...lines.slice(1)] };
  }
  if (lines.every(l => /^>/.test(l))) {
    const inner = lines.map(l => l.replace(/^>\s?/, ''));
    let cite = '';
    const last = inner[inner.length - 1];
    const cm = last.match(/^(?:--|――|——)\s*(.+)$/);
    if (cm && inner.length > 1) { cite = cm[1]; inner.pop(); }
    return { type: 'quote', text: inner.join(''), cite };
  }
  if (lines.every(l => /^- /.test(l))) {
    return { type: 'list', items: lines.map(l => l.slice(2)) };
  }
  return { type: 'p', text: lines.join('') };
}

/* ---------------- 整形ヘルパ ---------------- */

const disp = iso => iso.replaceAll('-', '.');
const dow = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  return DOW[new Date(y, m - 1, d).getDay()];
};
const dayDir = iso => iso.replaceAll('-', '/');
const dayPath = iso => `/${dayDir(iso)}/`;
const monthPath = key => `/${key.replace('-', '/')}/`;
const monthLabel = key => {
  const [y, m] = key.split('-');
  return `${y}年${Number(m)}月`;
};
// x.com / twitter.com のポスト URL、または ID そのものから ID を取る
const tweetId = s => /^\d+$/.test(s)
  ? s
  : s.match(/(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d+)/)?.[1] || '';

// 画像は md と同じ日ディレクトリに置き、ファイル名で参照する。URL は日ページの隣になる
const isRemote = src => /^https?:\/\//.test(src);
const assetUrl = (src, iso) => isRemote(src) ? src : dayPath(iso) + src;
// OGP など絶対 URL が要るところで使う。外部 URL はそのまま通す
const absUrl = url => isRemote(url) ? url : config.baseUrl + url;

// 本文冒頭 60 文字。OGP・RSS の説明文に使う。
function excerpt(entry) {
  const text = entry.segs
    .flatMap(s => s.blocks)
    .filter(b => b.type === 'p')
    .map(b => b.text)
    .join('')
    .replace(INLINE_LINK, '$1'); // 抜粋は本文だけ。リンクは表示文字だけ残す
  return text.length > 60 ? text.slice(0, 60) + '…' : text;
}

function firstImage(entry) {
  for (const s of entry.segs) {
    const img = s.blocks.find(b => b.type === 'img');
    if (img) return img;
  }
  return null;
}

// 検索用。読める文字だけをブロックから拾って一本に繋ぐ。
// 埋め込みは取得できた本文とキャプションだけ（iframe の中身は持っていない）。
function entryText(entry) {
  const out = [];
  const push = s => { if (s) out.push(String(s).replace(INLINE_LINK, '$1')); };
  for (const seg of entry.segs) {
    for (const b of seg.blocks) {
      switch (b.type) {
        case 'p': push(b.text); break;
        case 'quote': push(b.text); push(b.cite); break;
        case 'list': b.items.forEach(push); break;
        case 'add': push(b.date ? `追記 ${b.date}` : '追記'); b.paras.forEach(push); break;
        case 'img': case 'yt': case 'am': push(b.cap); break;
        case 'link': push(b.title); push(b.desc); push(b.site); break;
        case 'x': push(b.post?.text); push(b.cap); break;
      }
    }
  }
  return out.join(' ');
}

// HTML から取り出した文字列を素のテキストに戻す。OGP と X の oEmbed で共用する
const decodeEntities = s => s == null ? s : s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/* ---------------- リンクカードの OGP 取得 ---------------- */

const CACHE_FILE = path.join(ROOT, '.cache', 'linkcard.json');

// URL ごとの取得結果をキャッシュする。キャッシュがあればネットワークに出ない。
async function resolveLinkCards(entries) {
  const links = entries.flatMap(e => e.segs).flatMap(s => s.blocks).filter(b => b.type === 'link');
  const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};

  // タイトルまで手書きされているカードは取得不要
  const need = [...new Set(links.filter(b => !b.manual.title && !(b.href in cache)).map(b => b.href))];
  let fetched = 0;
  await Promise.all(need.map(async url => {
    try {
      cache[url] = await fetchOgp(url);
      fetched++;
    } catch (e) {
      console.warn(`linkcard: 取得失敗 ${url}（${e.message}）`);
    }
  }));
  if (fetched) {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
  }

  for (const b of links) {
    const og = cache[b.href] ?? {};
    const m = b.manual;
    b.title = m.title || og.title || b.href;
    b.desc = m.desc || og.desc || '';
    b.site = m.site || og.site || hostname(b.href);
    b.thumb = m.thumb || og.image || '';
  }
}

function hostname(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

async function fetchOgp(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; hibi-build)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = (await res.text()).slice(0, 500_000);

  // property= / name= どちらの書き方でも、属性順が違っても拾う
  const meta = name => {
    const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i'))?.[0];
    return tag?.match(/content=["']([^"']*)["']/)?.[1];
  };
  let image = decodeEntities(meta('og:image') || '');
  if (image) {
    try { image = new URL(image, res.url).href; } catch { image = ''; } // 相対 URL を解決
  }
  return {
    title: decodeEntities(meta('og:title')) || decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim()) || '',
    desc: decodeEntities(meta('og:description') || meta('description')) || '',
    site: decodeEntities(meta('og:site_name')) || hostname(res.url),
    image,
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
}

/* ---------------- 外部画像の寸法取得 ---------------- */

const IMG_CACHE_FILE = path.join(ROOT, '.cache', 'imagesize.json');
const readImageCache = () => fs.existsSync(IMG_CACHE_FILE) ? JSON.parse(fs.readFileSync(IMG_CACHE_FILE, 'utf8')) : {};
function writeImageCache(cache) {
  fs.mkdirSync(path.dirname(IMG_CACHE_FILE), { recursive: true });
  fs.writeFileSync(IMG_CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
}

// 書く画面が R2 に置いた写真の寸法を先に覚えておく。次のビルドで resolveRemoteImages が取りに行かないで済む。
function rememberImageSize(url, size) {
  const cache = readImageCache();
  cache[url] = size;
  writeImageCache(cache);
}

// 外部 URL の画像はファイルから測れないので、ビルド時に落として測り、キャッシュする。
// 取れなかったものは寸法なしで出す（レイアウトは揺れるが、ビルドは止めない）。
async function resolveRemoteImages(entries) {
  const imgs = entries.flatMap(e => e.segs).flatMap(s => s.blocks)
    .filter(b => b.type === 'img' && isRemote(b.src));
  if (!imgs.length) return;
  const cache = readImageCache();

  const need = [...new Set(imgs.filter(b => !(b.src in cache)).map(b => b.src))];
  let fetched = 0;
  await Promise.all(need.map(async url => {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; hibi-build)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      cache[url] = imageSizeOf(Buffer.from(await res.arrayBuffer()), url);
      fetched++;
    } catch (e) {
      console.warn(`画像: 寸法を取れない ${url}（${e.message}）`);
    }
  }));
  if (fetched) writeImageCache(cache);

  for (const b of imgs) b.size = cache[b.src] ?? null;
}

/* ---------------- X ポストの取得 ---------------- */

const X_CACHE_FILE = path.join(ROOT, '.cache', 'xpost.json');

// ポストごとの取得結果をキャッシュする。ここで取った中身が、iframe を出せないときのカードになる。
async function resolveXPosts(entries) {
  const posts = entries.flatMap(e => e.segs).flatMap(s => s.blocks).filter(b => b.type === 'x');
  if (!posts.length) return;
  const cache = fs.existsSync(X_CACHE_FILE) ? JSON.parse(fs.readFileSync(X_CACHE_FILE, 'utf8')) : {};

  const need = [...new Set(posts.filter(b => !(b.id in cache)).map(b => b.id))];
  let fetched = 0;
  await Promise.all(need.map(async id => {
    try {
      cache[id] = await fetchXPost(id);
      fetched++;
    } catch (e) {
      console.warn(`x: 取得失敗 ${id}（${e.message}）。カードは URL だけになる`);
    }
  }));
  if (fetched) {
    fs.mkdirSync(path.dirname(X_CACHE_FILE), { recursive: true });
    fs.writeFileSync(X_CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
  }

  // 一度取れたポストは、あとで消されてもキャッシュに残る。カードとしては読めるままになる。
  for (const b of posts) b.post = cache[b.id] || null;
}

// oEmbed は本文・表示名・ハンドル・日付だけを返す。画像と動画は入ってこない。
async function fetchXPost(id) {
  const api = 'https://publish.twitter.com/oembed?omit_script=1&dnt=true&lang=ja&url=' +
    encodeURIComponent(`https://twitter.com/i/status/${id}`);
  const res = await fetch(api, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`); // 消されたポスト・非公開アカウントは 404
  const json = await res.json();
  const html = String(json.html || '');

  const bodyHtml = html.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
  // 日付は blockquote 末尾のリンク。lang=ja なので「2006年3月21日」で来る
  const dateText = html.match(/<a href="[^"]*"[^>]*>([^<]*)<\/a>\s*<\/blockquote>/)?.[1] ?? '';
  const dm = dateText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const date = dm ? `${dm[1]}.${dm[2].padStart(2, '0')}.${dm[3].padStart(2, '0')}` : '';

  // 本文中のリンクは t.co の短縮 URL で来る。読めないので元の URL に戻す
  const tco = [...new Set([...bodyHtml.matchAll(/href="(https:\/\/t\.co\/\w+)"/g)].map(m => m[1]))];
  const expanded = new Map(await Promise.all(tco.map(async u => [u, await expandTco(u)])));

  let media = false;
  const text = decodeEntities(bodyHtml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, label) => {
      // 画像・動画への pic リンクは中身が出せないので落とし、あることだけ note に残す
      if (/^pic\.(?:twitter|x)\.com\//.test(label)) { media = true; return ''; }
      if (!/^https:\/\/t\.co\//.test(href)) return label; // ハッシュタグ・メンションは文字のまま
      const full = expanded.get(href);
      if (!full) return label;
      // ポスト本文では URL が直前の語にくっついていることがある。展開すると読めなくなるので離す
      return ' ' + full.replace(/^https?:\/\//, '').replace(/\/$/, '');
    })
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  return {
    name: json.author_name || '',
    handle: json.author_url ? '@' + json.author_url.split('/').pop() : '',
    url: json.url || `https://x.com/i/status/${id}`,
    date,
    text,
    media,
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
}

// t.co は本文を持たないリダイレクトなので、Location を辿るだけでよい
async function expandTco(url) {
  let current = url;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const next = res.headers.get('location');
      if (!next) return current === url ? '' : current;
      current = new URL(next, current).href;
      if (!/^https?:\/\/t\.co\//.test(current)) return current;
    } catch {
      return '';
    }
  }
  return current;
}

/* ---------------- レンダリング ---------------- */

function renderBlock(b, iso) {
  switch (b.type) {
    case 'p':
      return `<p>${inline(b.text)}</p>`;
    case 'quote':
      return `<blockquote><span class="q-body">${inline(b.text)}</span>${
        b.cite ? `<cite>${inline(b.cite)}</cite>` : ''
      }</blockquote>`;
    case 'list':
      return `<ul>${b.items.map(i => `<li>${inline(i)}</li>`).join('')}</ul>`;
    case 'add': {
      // ラベルは一段落目の頭に置く。本文の流れを切らずに続けて読ませるため。
      const paras = b.paras.length ? b.paras : [''];
      const label = `<span class="add-label">追記${b.date ? ` ${esc(b.date)}` : ''}</span>`;
      return `<aside class="addendum">${
        paras.map((p, i) => `<p>${i === 0 ? label : ''}${inline(p)}</p>`).join('')
      }</aside>`;
    }
    case 'link': {
      // サムネイルはラッパーに絶対配置し、画像の固有サイズがカードの高さに影響しないようにする
      const thumb = b.thumb
        ? `<span class="card-thumb"><img src="${esc(assetUrl(b.thumb, iso))}" alt="" loading="lazy" decoding="async"></span>`
        : '';
      return `<a class="card${b.thumb ? ' card--thumb' : ''}" href="${esc(b.href)}" target="_blank" rel="noopener">` +
        `<span class="card-text">` +
        `<span class="card-title">${esc(b.title)}</span>` +
        (b.desc ? `<span class="card-desc">${esc(b.desc)}</span>` : '') +
        `<span class="card-site">${esc(b.site)}</span>` +
        `</span>${thumb}</a>`;
    }
    case 'yt':
      return `<figure class="embed"><iframe class="embed-yt" src="https://www.youtube-nocookie.com/embed/${esc(b.id)}"` +
        ` title="${esc(b.cap || 'YouTube')}" loading="lazy"` +
        ` allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture; web-share" allowfullscreen></iframe>` +
        (b.cap ? `<figcaption>${esc(b.cap)}</figcaption>` : '') + `</figure>`;
    case 'am':
      return `<figure class="embed"><iframe class="embed-am${b.tall ? ' embed-am--tall' : ''}" src="${esc(b.url)}"` +
        ` title="${esc(b.cap || 'Apple Music')}" loading="lazy"` +
        ` allow="autoplay *; encrypted-media *; clipboard-write"` +
        ` sandbox="allow-forms allow-popups allow-same-origin allow-scripts allow-storage-access-by-user-activation allow-top-navigation-by-user-activation"></iframe>` +
        (b.cap ? `<figcaption>${esc(b.cap)}</figcaption>` : '') + `</figure>`;
    case 'x': {
      // HTML に入るのはカードのほう。iframe は読み込めたときだけ、スクリプトが上に載せる。
      // JS を切っていても、X に繋がらなくても、ポストが消えても、このカードが残る。
      const p = b.post;
      const href = p?.url || b.href;
      // 取得できていればハンドルはそこから。駄目なら書かれた URL から拾う
      // （ID だけで書いたときの /i/status/ は誰のものでもないので拾わない）
      const fromHref = b.href.match(/(?:twitter|x)\.com\/([^/]+)\/status/)?.[1] ?? '';
      const handle = p?.handle || (fromHref === 'i' ? '' : fromHref);
      const head = `<span class="xcard-head"><span class="xcard-mark">X</span>` +
        (handle ? `<span>${esc(handle.startsWith('@') ? handle : '@' + handle)}</span>` : '') +
        (p?.date ? `<span class="xcard-date">${esc(p.date)}</span>` : '') + `</span>`;
      const text = p?.text
        ? esc(p.text).replace(/\n/g, '<br>')
        : esc(href); // 取得に失敗したときは URL だけのカードになる
      return `<figure class="embed embed-x" data-x-id="${esc(b.id)}"` +
        ` data-x-title="${esc(b.cap || 'X のポスト')}">` +
        `<a class="xcard" href="${esc(href)}" target="_blank" rel="noopener">` +
        `${head}<span class="xcard-body">${text}</span>` +
        (p?.media ? `<span class="xcard-note">画像・動画あり — X で見る</span>` : '') +
        `</a>` +
        (b.cap ? `<figcaption>${esc(b.cap)}</figcaption>` : '') + `</figure>`;
    }
  }
}

function renderFigure(im, iso) {
  // 外部 URL は resolveRemoteImages で測った寸法を使う。ローカルはファイルから読む
  const size = isRemote(im.src) ? im.size : imageSize(path.join(CONTENT, dayDir(iso), im.src));
  const dim = size ? ` width="${size.w}" height="${size.h}" style="aspect-ratio:${size.w}/${size.h}"` : '';
  return `<figure class="photos">` +
    `<img src="${esc(assetUrl(im.src, iso))}"${dim} alt="" loading="lazy" decoding="async">` +
    (im.cap ? `<figcaption>${esc(im.cap)}</figcaption>` : '') + `</figure>`;
}

// id は日付の下の時刻の並び（.times）から飛ぶ先。ファイル名と同じ HH-MM。
// 月ページは一枚に複数の日が載り、同じ時刻が別の日と衝突するので id を置かない。
function renderSeg(seg, iso, { anchor }) {
  const parts = [`<time datetime="${iso}T${seg.time}">${seg.time}</time>`];
  for (const b of seg.blocks) {
    parts.push(b.type === 'img' ? renderFigure(b, iso) : renderBlock(b, iso));
  }
  return `<div class="seg"${anchor ? ` id="${timeId(seg.time)}"` : ''}><div class="prose">${parts.join('')}</div></div>`;
}

const timeId = time => time.replace(':', '-');

// linkDate: 月ページでは日付が日ページへのリンク、日ページではリンクにしない。
// data-day: 一覧と日のあいだの遷移で、同じ日の記事を両方のページで見つけるための目印（assets/vt.js）。
// 日付の下にその日の時刻を並べ、押すとその時刻ブロックへ飛ぶ。
// 日ページはページの中のアンカー、月ページは日ページのアンカー（日付と同じく日へ移る）。
function renderArticle(entry, { linkDate }) {
  const anchor = !linkDate;
  const dateInner = `<span class="date">${disp(entry.iso)}</span><span class="dow">${dow(entry.iso)}</span>`;
  const meta = linkDate
    ? `<a class="datelink" href="${dayPath(entry.iso)}">${dateInner}</a>`
    : `<span class="datelink">${dateInner}</span>`;
  const base = anchor ? '' : dayPath(entry.iso);
  const times = `<nav class="times" aria-label="この日の時刻">${
    entry.segs.map(s => `<a href="${base}#${timeId(s.time)}">${s.time}</a>`).join('')
  }</nav>`;
  return `<article data-day="${entry.iso}"><div class="meta">${meta}${times}</div><div class="body">${
    entry.segs.map(s => renderSeg(s, entry.iso, { anchor })).join('')
  }</div></article>`;
}

// 縦の並びが暦順（月ページなら 1 日が上、31 日が下）なので、ページャも同じ向きに揃える。
// 左が過去、右が未来。カレンダーの繰り方と同じ。
function pagerItem(target, key, side) {
  const k = `<span class="k">${side === 'left' ? `← ${key}` : `${key} →`}</span>`;
  const right = side === 'right' ? ' right' : '';
  if (!target) return `<span class="off${right}">${k}<span>—</span></span>`;
  return `<a${right ? ' class="right"' : ''} href="${target.href}">${k}<span>${esc(target.label)}</span></a>`;
}

// X の埋め込み iframe は高さが決まっていない。iframe 自身が postMessage で高さを伝えてくるので、
// それを受け取ってから表に出す。受け取れなければカードのままにする。
// 埋め込みが高さを送ってくるのは実寸の高さがあるときだけで、visibility:hidden や高さ 0 では黙る。
// そのため仮の高さを持たせたまま、カードの上に opacity:0 で重ねて読み込ませる（CSS 側を参照）。
const X_SCRIPT = `<script>
(() => {
  const figs = [...document.querySelectorAll('.embed-x[data-x-id]')];
  if (!figs.length) return;
  const frames = new Map();
  addEventListener('message', e => {
    if (e.origin !== 'https://platform.twitter.com') return;
    const call = e.data && e.data['twttr.embed'];
    if (!call || !/resize/.test(call.method || '')) return;
    const height = call.params && call.params[0] && call.params[0].height;
    if (!height) return;
    for (const [fig, frame] of frames) {
      if (frame.contentWindow === e.source) {
        frame.style.height = height + 'px';
        fig.classList.add('is-live');
      }
    }
  });
  const load = fig => {
    const frame = document.createElement('iframe');
    frame.className = 'embed-x-frame';
    frame.title = fig.dataset.xTitle || 'X';
    frame.src = 'https://platform.twitter.com/embed/Tweet.html?id=' +
      encodeURIComponent(fig.dataset.xId) + '&theme=light&dnt=true&lang=ja&hideThread=true';
    fig.prepend(frame);
    frames.set(fig, frame);
  };
  // 画面に近づくまで X には何も取りに行かない
  const io = new IntersectionObserver((es, obs) => {
    for (const en of es) if (en.isIntersecting) { obs.unobserve(en.target); load(en.target); }
  }, { rootMargin: '400px' });
  figs.forEach(fig => io.observe(fig));
})();
<\/script>`;

// 末尾の一行。ページに常に見えているのは「日付」「検索」の二語だけで、どちらも押すと覆いが出る。
// 日付は記述のある日をカレンダーで出して移る（assets/jump.js、日の一覧は /days.json）。
// 検索は /search.json を読んでブラウザ側で絞り込む（assets/search.js）。
// どちらのボタンも hidden にしてあり、スクリプトが動いたときだけ出る（JS が無いと開けないため）。
// あいだの中黒も hidden で、二語とも出たときだけ引く。
const FOOT = `<footer class="foot"><span class="foot-nav">` +
  `<button class="foot-item is-date jump-open" type="button" hidden>日付</button>` +
  `<span class="foot-sep" hidden>·</span>` +
  `<button class="foot-item is-search search-open" type="button" hidden>検索</button>` +
  `</span></footer>`;

const JUMP_DIALOG = `<dialog class="jump" aria-label="日付で移る">` +
  `<div class="jump-head">` +
  `<button class="jump-prev" type="button" aria-label="前の月">‹</button>` +
  `<a class="jump-title"></a>` +
  `<button class="jump-next" type="button" aria-label="次の月">›</button>` +
  `</div><div class="jump-grid"></div></dialog>`;
const SEARCH_DIALOG = `<dialog class="search" aria-label="本文を検索">` +
  `<input class="search-input" type="search" placeholder="検索" aria-label="本文を検索"` +
  ` autocomplete="off" autocapitalize="off" spellcheck="false">` +
  `<div class="search-panel" hidden></div></dialog>`;

function pageShell({ title, description, canonical, og, body }) {
  const head = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    // / は最新の日ページの写しなので、パスからは日が読めない。vt.js がその対応を知るために置く。
    `<meta name="home-day" content="${homeDay}">`,
    `<title>${esc(title)}</title>`,
    description ? `<meta name="description" content="${esc(description)}">` : '',
    canonical ? `<link rel="canonical" href="${esc(canonical)}">` : '',
    `<meta property="og:site_name" content="${esc(config.title)}">`,
    ...(og || []),
    `<link rel="alternate" type="application/rss+xml" title="${esc(config.title)}" href="/feed.xml">`,
    `<link rel="preconnect" href="https://fonts.googleapis.com">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    // 実際に使うウェイトだけ。Barlow は .date の 600、Shippori は blockquote の 400、
    // Roboto Mono は 400 のみ（未使用の 500 を足すと @font-face が倍になり、その CSS は描画を止める）
    `<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600&family=Shippori+Mincho:wght@400&family=Roboto+Mono:wght@400&display=swap" rel="stylesheet">`,
    `<link rel="stylesheet" href="/assets/style.css">`,
    `<script src="/assets/search.js" defer></script>`,
    `<script src="/assets/jump.js" defer></script>`,
    // vt.js は defer にしない。pagereveal は最初の描画のときに飛んでくるので、
    // 解析の終わりまで待つ defer だと登録が間に合わず、行き先の記事に名前が付かない。
    `<script src="/assets/vt.js"></script>`,
  ].filter(Boolean).join('\n');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
${head}
</head>
<body>
<div class="wrap">
${body}
${FOOT}
</div>
${SEARCH_DIALOG}
${JUMP_DIALOG}
${body.includes('class="embed embed-x"') ? X_SCRIPT + '\n' : ''}</body>
</html>
`;
}

/* ---------------- ページ生成 ---------------- */

function monthPageHtml(entries, monthKeys, key) {
  const mi = monthKeys.indexOf(key);
  const inMonth = entries.filter(e => e.iso.slice(0, 7) === key);
  const canonical = config.baseUrl + monthPath(key);
  const nav = (k, side) =>
    pagerItem(k ? { href: monthPath(k), label: monthLabel(k) } : null, side === 'left' ? '前の月' : '次の月', side);
  const body =
    `<main>${inMonth.map(e => renderArticle(e, { linkDate: true })).join('\n')}</main>\n` +
    `<nav class="pager pager--month" aria-label="月の移動">${nav(monthKeys[mi - 1], 'left')}${nav(monthKeys[mi + 1], 'right')}</nav>`;
  return pageShell({
    title: `${monthLabel(key)} | ${config.title}`,
    canonical,
    og: [
      `<meta property="og:type" content="website">`,
      `<meta property="og:title" content="${esc(monthLabel(key))}">`,
      `<meta property="og:url" content="${esc(canonical)}">`,
    ],
    body,
  });
}

function dayPageHtml(entries, entry) {
  const idx = entries.indexOf(entry);
  const monthKey = entry.iso.slice(0, 7);
  const url = config.baseUrl + dayPath(entry.iso);
  const description = excerpt(entry);
  const image = firstImage(entry);
  const nav = (e, side) =>
    pagerItem(e ? { href: dayPath(e.iso), label: `${disp(e.iso)} ${dow(e.iso)}` } : null, side === 'left' ? '前の日' : '次の日', side);
  const body =
    `<a class="back" href="${monthPath(monthKey)}">← ${esc(monthLabel(monthKey))}の一覧へ</a>\n` +
    `<main>${renderArticle(entry, { linkDate: false })}</main>\n` +
    `<nav class="pager pager--day" aria-label="日の移動">${nav(entries[idx - 1], 'left')}${nav(entries[idx + 1], 'right')}</nav>`;
  return pageShell({
    title: `${disp(entry.iso)} | ${config.title}`,
    description,
    canonical: url,
    og: [
      `<meta property="og:type" content="article">`,
      `<meta property="og:title" content="${disp(entry.iso)}">`,
      `<meta property="og:description" content="${esc(description)}">`,
      `<meta property="og:url" content="${esc(url)}">`,
      image ? `<meta property="og:image" content="${esc(absUrl(assetUrl(image.src, entry.iso)))}">` : '',
    ].filter(Boolean),
    body,
  });
}

// Cloudflare Pages などの静的ホスティングが存在しない URL に返す 404。日ページと同じ体裁にする。
function notFoundPageHtml() {
  const body =
    `<main><article><div class="meta"><span class="datelink">` +
    `<span class="date">404</span><span class="dow">NOT FOUND</span>` +
    `</span></div><div class="body"><div class="seg"><div class="prose">` +
    `<p>そのページはありません。</p>` +
    `<p><a href="/">最新の日へ</a></p>` +
    `</div></div></div></article></main>`;
  return pageShell({
    title: `404 | ${config.title}`,
    og: [`<meta name="robots" content="noindex">`],
    body,
  });
}

// ブラウザ側で絞り込むための全文インデックス。日付と本文だけの小さな JSON。
// 新しい日から並べる（search.js は当たったうちの先頭から上限までしか出さない）。
function searchIndex(entries) {
  return JSON.stringify([...entries].reverse().map(e => ({ d: e.iso, t: entryText(e) })));
}

// 新しい日から 30 件。
function feedXml(entries) {
  const items = [...entries].reverse().slice(0, 30).map(e => `  <item>
    <title>${disp(e.iso)}</title>
    <link>${config.baseUrl}${dayPath(e.iso)}</link>
    <guid>${config.baseUrl}${dayPath(e.iso)}</guid>
    <description>${esc(excerpt(e))}</description>
    <pubDate>${new Date(`${e.iso}T00:00:00+09:00`).toUTCString()}</pubDate>
  </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${esc(config.title)}</title>
  <link>${config.baseUrl}/</link>
  <description>${esc(config.title)}</description>
  <language>ja</language>
${items}
</channel>
</rss>
`;
}

/* ---------------- ビルド ---------------- */

function write(rel, content) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function build() {
  const started = performance.now();
  config = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
  // baseUrl はパスと連結するので、末尾のスラッシュを落として持つ。
  config.baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');

  const entries = collectEntries();
  if (!entries.length) throw new Error('content/ に日記ファイルがない');
  await resolveLinkCards(entries);
  await resolveXPosts(entries);
  await resolveRemoteImages(entries);
  const monthKeys = [...new Set(entries.map(e => e.iso.slice(0, 7)))];
  homeDay = entries.at(-1).iso;

  fs.rmSync(OUT, { recursive: true, force: true });

  for (const key of monthKeys) {
    write(monthPath(key).slice(1) + 'index.html', monthPageHtml(entries, monthKeys, key));
  }
  // トップは最新の日ページと同じ内容。一覧は上の「一覧へ」から辿る。正規 URL は日ページに向ける。
  write('index.html', dayPageHtml(entries, entries.at(-1)));

  for (const entry of entries) {
    write(dayPath(entry.iso).slice(1) + 'index.html', dayPageHtml(entries, entry));
  }

  write('404.html', notFoundPageHtml());
  write('feed.xml', feedXml(entries));
  write('search.json', searchIndex(entries));
  // 日付ジャンプ用。カレンダーを描くのに要るのは日付だけで、全文を持つ search.json は重い。
  write('days.json', JSON.stringify(entries.map(e => e.iso)));

  const assets = path.join(ROOT, 'assets');
  for (const f of fs.readdirSync(assets, { recursive: true })) {
    const src = path.join(assets, f);
    if (path.basename(f).startsWith('.') || !fs.statSync(src).isFile()) continue;
    write(path.join('assets', f), fs.readFileSync(src));
  }

  // 日ディレクトリの画像などを日ページの隣へコピー（md 以外すべて）。
  // img/ のような下の階層もそのままの形で写す。
  for (const entry of entries) {
    const dir = path.join(CONTENT, dayDir(entry.iso));
    for (const f of fs.readdirSync(dir, { recursive: true })) {
      if (f.endsWith('.md') || path.basename(f).startsWith('.')) continue;
      const src = path.join(dir, f);
      if (!fs.statSync(src).isFile()) continue;
      write(path.join(dayDir(entry.iso), f), fs.readFileSync(src));
    }
  }

  const elapsed = performance.now() - started;
  console.log(`built: ${entries.length} days, ${monthKeys.length} months → ${rel(OUT)}/ (${elapsed.toFixed(0)}ms)`);
}

await build();

/* ---------------- watch モード ---------------- */

if (process.argv.includes('--watch')) {
  // 変更を 100ms でまとめて再ビルド。書きかけでパースに失敗しても watch は続ける。
  // 書く画面はこの完了を待ってから保存を返すので、待てるように Promise を返す。
  let timer = null;
  let waiting = [];
  const rebuild = () => new Promise(resolve => {
    waiting.push(resolve);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const done = waiting;
      waiting = [];
      await build().catch(e => console.error('build error:', e.message));
      for (const r of done) r();
    }, 100);
  });
  for (const target of [CONTENT, path.join(ROOT, 'assets'), path.join(ROOT, 'site.config.json')]) {
    fs.watch(target, { recursive: true }, rebuild);
  }

  // 書く画面（/_write）。確認サーバのときだけ積む。
  // 同期（deploy）は content/ → site/ を見ているときだけ。npm run ref の一時ディレクトリでは出さない。
  const { editorHandler, local, INJECT } = await import('./scripts/editor.mjs');
  const canDeploy = !process.env.HIBI_CONTENT && !process.env.HIBI_OUT;
  const editor = editorHandler({
    content: CONTENT,
    rebuild,
    root: ROOT,
    canDeploy,
    // 写真を R2 に置くときに寸法を測って覚える（build.mjs の寸法読みとキャッシュを共有する）
    measureImage: imageSizeOf,
    rememberImageSize,
  });
  // 日ページに載せるエディタは site/ には書かず、返すときに差す（エディタ入りの site/ を上げる事故を防ぐ）。
  // 出す条件は同期ボタンと同じ：content/ → site/ を見ていて、手元（loopback）からの読み込みのとき。
  const inject = (req, file, html) =>
    canDeploy && local(req) && path.extname(file) === '.html'
      ? Buffer.from(String(html).replace(/<\/body>/i, INJECT + '</body>'))
      : html;

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.xml': 'application/xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  };
  const port = Number(process.env.PORT) || 8888;
  http.createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (await editor(req, res, url)) return;
    let file = path.normalize(path.join(OUT, url));
    if (!file.startsWith(OUT + path.sep) && file !== OUT) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      // 本番（Cloudflare Pages など）と同じく生成した 404.html を返す。
      const notFound = path.join(OUT, '404.html');
      res.writeHead(404, { 'Content-Type': fs.existsSync(notFound) ? MIME['.html'] : MIME['.txt'] })
        .end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : '404');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      .end(inject(req, file, fs.readFileSync(file)));
  }).listen(port, () => {
    console.log(`watching ${rel(CONTENT)}/ assets/ site.config.json — http://localhost:${port}`);
    console.log(`書く画面: http://localhost:${port}/_write`);
  });
}
