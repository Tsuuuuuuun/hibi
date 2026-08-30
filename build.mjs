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

// ログ用。ROOT の外（npm run ref の一時ディレクトリ）は絶対パスのまま出す。
const rel = p => p.startsWith(ROOT + path.sep) ? path.relative(ROOT, p) : p;

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------------- 画像サイズ ---------------- */

// width/height/aspect-ratio を必ず出すため、JPEG/PNG のヘッダから寸法を読む。
function imageSize(file) {
  const buf = fs.readFileSync(file);
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
  throw new Error(`画像サイズを読めない: ${file}（JPEG/PNG のみ対応）`);
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
  return entries.sort((a, b) => b.iso.localeCompare(a.iso)); // 新しい日から
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
  if (/^@追記\s/.test(first)) {
    return { type: 'add', date: first.replace(/^@追記\s+/, ''), paras: lines.slice(1) };
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
// 画像は md と同じ日ディレクトリに置き、ファイル名で参照する。URL は日ページの隣になる
const assetUrl = (src, iso) => /^https?:\/\//.test(src) ? src : dayPath(iso) + src;

// 本文冒頭 60 文字。OGP・RSS の説明文に使う。
function excerpt(entry) {
  const text = entry.segs
    .flatMap(s => s.blocks)
    .filter(b => b.type === 'p')
    .map(b => b.text)
    .join('');
  return text.length > 60 ? text.slice(0, 60) + '…' : text;
}

function firstImage(entry) {
  for (const s of entry.segs) {
    const img = s.blocks.find(b => b.type === 'img');
    if (img) return img;
  }
  return null;
}

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
  const dec = s => s == null ? s : s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  let image = dec(meta('og:image') || '');
  if (image) {
    try { image = new URL(image, res.url).href; } catch { image = ''; } // 相対 URL を解決
  }
  return {
    title: dec(meta('og:title')) || dec(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim()) || '',
    desc: dec(meta('og:description') || meta('description')) || '',
    site: dec(meta('og:site_name')) || hostname(res.url),
    image,
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
}

/* ---------------- レンダリング ---------------- */

function renderBlock(b, iso) {
  switch (b.type) {
    case 'p':
      return `<p>${esc(b.text)}</p>`;
    case 'quote':
      return `<blockquote><span class="q-body">${esc(b.text)}</span>${
        b.cite ? `<cite>${esc(b.cite)}</cite>` : ''
      }</blockquote>`;
    case 'list':
      return `<ul>${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
    case 'add': {
      // ラベルは一段落目の頭に置く。本文の流れを切らずに続けて読ませるため。
      const paras = b.paras.length ? b.paras : [''];
      const label = `<span class="add-label">追記 ${esc(b.date)}</span>`;
      return `<aside class="addendum">${
        paras.map((p, i) => `<p>${i === 0 ? label : ''}${esc(p)}</p>`).join('')
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
  }
}

function renderFigure(im, iso) {
  const { w, h } = imageSize(path.join(CONTENT, dayDir(iso), im.src));
  return `<figure class="photos">` +
    `<img src="${esc(assetUrl(im.src, iso))}" width="${w}" height="${h}" alt="" loading="lazy" decoding="async" style="aspect-ratio:${w}/${h}">` +
    (im.cap ? `<figcaption>${esc(im.cap)}</figcaption>` : '') + `</figure>`;
}

function renderSeg(seg, iso) {
  const parts = [`<time datetime="${iso}T${seg.time}">${seg.time}</time>`];
  for (const b of seg.blocks) {
    parts.push(b.type === 'img' ? renderFigure(b, iso) : renderBlock(b, iso));
  }
  return `<div class="seg"><div class="prose">${parts.join('')}</div></div>`;
}

// linkDate: 月ページでは日付が日ページへのリンク、日ページではリンクにしない。
function renderArticle(entry, { linkDate }) {
  const dateInner = `<span class="date">${disp(entry.iso)}</span><span class="dow">${dow(entry.iso)}</span>`;
  const meta = linkDate
    ? `<a class="datelink" href="${dayPath(entry.iso)}">${dateInner}</a>`
    : `<span class="datelink">${dateInner}</span>`;
  return `<article><div class="meta">${meta}</div><div class="body">${
    entry.segs.map(s => renderSeg(s, entry.iso)).join('')
  }</div></article>`;
}

function pagerItem(target, key, dir) {
  const k = `<span class="k">${dir === 'prev' ? `← ${key}` : `${key} →`}</span>`;
  const next = dir === 'next' ? ' next' : '';
  if (!target) return `<span class="off${next}">${k}<span>—</span></span>`;
  return `<a${next ? ' class="next"' : ''} href="${target.href}">${k}<span>${esc(target.label)}</span></a>`;
}

function pageShell({ title, description, canonical, og, body }) {
  const head = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
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
  ].filter(Boolean).join('\n');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
${head}
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>
`;
}

/* ---------------- ページ生成 ---------------- */

function monthPageHtml(entries, monthKeys, key, { canonical }) {
  const mi = monthKeys.indexOf(key);
  const inMonth = entries.filter(e => e.iso.slice(0, 7) === key);
  const nav = (k, dir) =>
    pagerItem(k ? { href: monthPath(k), label: monthLabel(k) } : null, dir === 'prev' ? '前の月' : '次の月', dir);
  const body =
    `<main>${inMonth.map(e => renderArticle(e, { linkDate: true })).join('\n')}</main>\n` +
    `<nav class="pager pager--month" aria-label="月の移動">${nav(monthKeys[mi + 1], 'prev')}${nav(monthKeys[mi - 1], 'next')}</nav>`;
  return pageShell({
    title: canonical === config.baseUrl + '/' ? config.title : `${monthLabel(key)} | ${config.title}`,
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
  const nav = (e, dir) =>
    pagerItem(e ? { href: dayPath(e.iso), label: `${disp(e.iso)} ${dow(e.iso)}` } : null, dir === 'prev' ? '前の日' : '次の日', dir);
  const body =
    `<a class="back" href="${monthPath(monthKey)}">← ${esc(monthLabel(monthKey))}の一覧へ</a>\n` +
    `<main>${renderArticle(entry, { linkDate: false })}</main>\n` +
    `<nav class="pager pager--day" aria-label="日の移動">${nav(entries[idx + 1], 'prev')}${nav(entries[idx - 1], 'next')}</nav>`;
  return pageShell({
    title: `${disp(entry.iso)} | ${config.title}`,
    description,
    canonical: url,
    og: [
      `<meta property="og:type" content="article">`,
      `<meta property="og:title" content="${disp(entry.iso)}">`,
      `<meta property="og:description" content="${esc(description)}">`,
      `<meta property="og:url" content="${esc(url)}">`,
      image ? `<meta property="og:image" content="${esc(config.baseUrl + assetUrl(image.src, entry.iso))}">` : '',
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
    `<p><a href="/">最新の月の一覧へ</a></p>` +
    `</div></div></div></article></main>`;
  return pageShell({
    title: `404 | ${config.title}`,
    og: [`<meta name="robots" content="noindex">`],
    body,
  });
}

function feedXml(entries) {
  const items = entries.slice(0, 30).map(e => `  <item>
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
  const monthKeys = [...new Set(entries.map(e => e.iso.slice(0, 7)))];

  fs.rmSync(OUT, { recursive: true, force: true });

  for (const key of monthKeys) {
    write(monthPath(key).slice(1) + 'index.html',
      monthPageHtml(entries, monthKeys, key, { canonical: config.baseUrl + monthPath(key) }));
  }
  // トップは最新の月と同じ内容。正規 URL は月ページに向ける。
  write('index.html', monthPageHtml(entries, monthKeys, monthKeys[0], { canonical: config.baseUrl + '/' }));

  for (const entry of entries) {
    write(dayPath(entry.iso).slice(1) + 'index.html', dayPageHtml(entries, entry));
  }

  write('404.html', notFoundPageHtml());
  write('feed.xml', feedXml(entries));
  write('assets/style.css', fs.readFileSync(path.join(ROOT, 'assets', 'style.css')));

  // 日ディレクトリの画像などを日ページの隣へコピー（md 以外すべて）
  for (const entry of entries) {
    const dir = path.join(CONTENT, dayDir(entry.iso));
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md') || f.startsWith('.')) continue;
      write(path.join(dayDir(entry.iso), f), fs.readFileSync(path.join(dir, f)));
    }
  }

  const elapsed = performance.now() - started;
  console.log(`built: ${entries.length} days, ${monthKeys.length} months → ${rel(OUT)}/ (${elapsed.toFixed(0)}ms)`);
}

await build();

/* ---------------- watch モード ---------------- */

if (process.argv.includes('--watch')) {
  // 変更を 100ms でまとめて再ビルド。書きかけでパースに失敗しても watch は続ける。
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      build().catch(e => console.error('build error:', e.message));
    }, 100);
  };
  for (const target of [CONTENT, path.join(ROOT, 'assets'), path.join(ROOT, 'site.config.json')]) {
    fs.watch(target, { recursive: true }, rebuild);
  }

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
  };
  const port = Number(process.env.PORT) || 8888;
  http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
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
      .end(fs.readFileSync(file));
  }).listen(port, () => {
    console.log(`watching ${rel(CONTENT)}/ assets/ site.config.json — http://localhost:${port}`);
  });
}
