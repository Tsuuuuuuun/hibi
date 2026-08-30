# 日々

個人の日記サイト。

## 使い方

```sh
npm run build   # site/ に生成
npm run dev     # 監視ビルド＋ http://localhost:8888 で確認（PORT で変更可）
npm run new     # 今の日付・時刻のファイルを content/ に作る
npm run ref     # 記法のデモページをブラウザで開く
```

`npm run dev` は `content/`・`assets/`・`site.config.json` の変更を監視して自動で再ビルドする。

生成物は `site/` に入る。そのまま任意の静的ホスティングに置ける。

## 書き方

時刻ブロックごとに一ファイル。パスが日付と時刻になる。

```
content/2026/08/30/10-40.md   ← 2026-08-30 の 10:40 の記述
content/2026/08/30/19-20.md   ← 同じ日の 19:20 の記述
content/2026/08/30/hako.jpg   ← その日の写真も同じディレクトリに置く
```

ファイルの中身は本文だけ。時刻はファイル名（`HH-MM.md`）から取る。

`npm run new`（`scripts/new.mjs`）はこのパスのファイルを実行時の日付・時刻で作る。後ろに文章を書くとそれが本文になる。

```sh
npm run new                    # content/2026/08/30/10-40.md を空で作る
npm run new "梅雨明け。"       # 同じファイルを本文入りで作る
```

同じ分のファイルがすでにあるときは、空行を挟んで後ろに足す。

日付と時刻は手で指定できる。書き忘れた日を後から足すとき用。

```sh
npm run new -- -d 2026-08-29 -t 21:30 "昨日のこと。"
```

- `-d` / `--date` — `YYYY-MM-DD`
- `-t` / `--time` — `HH:MM`（`HH-MM` でも可）
- `--` — これより後ろはすべて本文。本文が `-` で始まるときに使う

`npm run` 経由でオプションを渡すときは、`npm run new -- ...` のように `--` を挟む。

```
段落。空行で区切る。

段落の続き。

![キャプション](hako.jpg)
```

- `![キャプション](xxx.jpg)` — 写真。同じ日ディレクトリのファイル名で参照する。書いた位置に、一枚につき一つの図として出る
- `> 引用文` — 引用。最後の行を `> -- 出典` にすると出典が付く
- `- 項目` — 箇条書き
- `@追記 09.02` — 追記。続く行がその段落になる
- `@link URL` — リンクカード。タイトル・説明・サイト名・サムネイルはビルド時に OGP から自動取得し、`.cache/linkcard.json` にキャッシュする（二回目以降はネットワークに出ない）。`@link URL | タイトル | 説明 | サイト名 | サムネイル` と手書きすれば取得値より優先。取得に失敗したときは警告を出して URL だけのカードになる
- `@youtube 動画ID | キャプション` — YouTube 埋め込み
- `@music 共有リンク | キャプション` — Apple Music 埋め込み。`https://music.apple.com/...` の共有リンクをそのまま書けば埋め込み用 URL に変換される。曲（`?i=` 付き）は小さい枠、アルバム・プレイリストは背の高い枠になる（`| tall` で強制も可）

記法を一通り並べたデモページがある。`npm run ref` で一時ディレクトリにビルドしてブラウザで開くので、`ref/` の md と実際の見た目を見比べられる。`content/` と `site/` には触らないから、記法を試す場所としても使える（`ref/` を編集すると作り直す）。ポートは 8899、`PORT` で変えられる。

写真はその日のディレクトリに置く（JPEG か PNG）。ビルド時に日ページの隣（`/2026/08/30/hako.jpg`）へコピーされ、ヘッダから寸法を読んで `width`/`height`/`aspect-ratio` を出すので、読み込み中もレイアウトがずれない。

## URL

- `/` — 最新の月の一覧
- `/2026/08/` — 月ごとの一覧
- `/2026/08/30/` — 日ページ（記事の正規 URL）
- `/feed.xml` — RSS。タイトルは日付、説明は本文の冒頭 60 文字
- `/404.html` — 存在しない URL 用のページ。Cloudflare Pages や Netlify などは出力ルートの `404.html` を自動で使う。`npm run dev` の確認サーバも同じものを返す

## 設定

`site.config.json`:

- `title` — サイト名
- `baseUrl` — 公開 URL。**公開前に必ず書き換える**（canonical・OGP・RSS に使う）

## 公開

Cloudflare Workers の Static Assets に `site/` を直接アップロードする。Cloudflare 側でビルドが走らないので、無料プランの月 500 回のビルド枠を使わない。

事前に一度だけ用意するもの。

- **API トークン** — Cloudflare ダッシュボードの My Profile → API Tokens で「Workers スクリプト:編集」の権限のものを作る
- **アカウント ID** — Workers & Pages のページの右側に出ている

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...

npm run deploy                              # ビルドしてアップロード
node scripts/deploy.mjs --dry-run           # 送る内容だけ見る（通信しない）
node scripts/deploy.mjs --workers-dev       # <name>.<subdomain>.workers.dev を有効にする
```

Worker 名は既定で `hibi`。`--name` か `HIBI_WORKER_NAME` で変えられる。事前に Cloudflare 側で作っておく必要はない。初回のデプロイでその名前の Worker ができる。

同名の Worker がすでにあり、それがこのスクリプトの作ったものでないときは、上書きせずに止まる。意図した上書きなら `--force`。

変わったファイルだけを送る。二回目以降は数秒で終わる。

独自ドメインは Cloudflare ダッシュボードの Worker の設定で Custom Domain を足す。ドメインが Cloudflare のゾーンにあれば証明書も自動で付く。`site.config.json` の `baseUrl` をそのドメインに合わせておく。

`/2026/08/30` から `/2026/08/30/` への解決と、存在しない URL への `404.html` は、デプロイ時に Worker のアセット設定（`html_handling` / `not_found_handling`）として一緒に送っているので、別途の設定ファイルは要らない。

## 備考

- `.cache/linkcard.json` はリンクカードの取得結果のキャッシュ。
- 幅 681px を境に、日付が本文の上へ移って一段組になる
- 月一覧では日付が日ページへのリンク。日ページでは日付をリンクにしない
