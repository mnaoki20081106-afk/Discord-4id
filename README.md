# discord-4id

Discord の **3文字・4文字ユーザー名の空き** を総当りで探して、Discord Bot の `/id` で一覧を返すツールです。
**Cloudflare Workers の無料プラン**だけで動きます（cron でスキャン、D1 に保存、Interactions エンドポイントで応答）。
必要なら **GitHub Actions** からスキャンすることもできます（後述）。

```
 ┌──────────── Cloudflare Workers (無料) ────────────┐
 │  cron (毎分) ──► 名前を生成 ──► Discord 確認API  │
 │                     │                             │
 │                     ▼                             │
 │                D1 (空き一覧・進捗)                 │
 │                     ▲                             │
 │  /id (Interactions) ┘ ──► 一覧を返信              │
 └───────────────────────────────────────────────────┘
        ▲ (任意) GitHub Actions から /api/batch, /api/report
```

## 仕組み

- 文字種は Discord のユーザー名で使える `a-z 0-9 _ .`（38種）。`..` を含む名前はスキップ。
  - 4文字: 2,085,136 通り（`SCAN_LENGTHS="3,4"` にすれば 3文字 54,872 通りも対象）
- 先頭から順番に調べると偏るので、周回ごとにシャッフルした順番で**全組み合わせを1回ずつ**確認します。
- 複数の文字数を指定した場合は、その順に1周ずつ回ります。
- 確認には Discord の登録画面が使っている
  `POST /api/v9/unique-username/username-attempt-unauthed` を使います（**ユーザートークン不要**、セルフBotにはしていません）。
- 429（レート制限）が返ったら `retry_after` の時間だけ必ず休みます。
- 見つけた名前はリストに残し、定期的に再確認して「使える / 使えない」に仕分けます。

## /id コマンド

**4文字 ID を常にスキャン**し、一度でも空きだった ID は**リストにずっと残します**。
リストは定期的に再確認して **✅ 使える / ❌ 使えない（取られた）** に仕分けます
（使える: `RECHECK_HOURS` ごと、使えない: `TAKEN_RECHECK_HOURS` ごと。空き直したら「使える」に戻ります）。

| オプション | 説明 |
|---|---|
| `status` | `✅ 使える`（既定） / `❌ 使えない` / `📋 すべて` |
| `count`  | 表示件数（1〜50、既定 20） |
| `hidden` | 自分だけに表示 |

返信には各 ID の最終確認時刻（取られたものは取られた時刻）と、スキャンの進捗・リストの件数が表示されます。

## セットアップ

### 1. Discord アプリを作る
1. <https://discord.com/developers/applications> で New Application
2. **General Information** の `Application ID` と `Public Key` をメモ
3. **Bot** でトークンを発行してメモ（コマンド登録にだけ使います。Worker には置きません）

### 2. Cloudflare にデプロイ
```bash
npm install
npx wrangler login
npx wrangler d1 create discord-4id      # 出力された database_id を wrangler.toml に貼る
npm run db:init                          # テーブル作成
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_APPLICATION_ID
npm run deploy                           # https://discord-4id.<you>.workers.dev が発行される
```

### 3. Discord と接続
1. Developer Portal の **General Information → Interactions Endpoint URL** に Worker の URL
   （`https://discord-4id.<you>.workers.dev/`）を入れて保存（署名検証が通れば保存できます）
2. コマンド登録:
   ```bash
   DISCORD_APPLICATION_ID=xxx DISCORD_BOT_TOKEN=xxx npm run register
   # すぐ試したいときは DISCORD_GUILD_ID=サーバーID も付ける（ギルドコマンドは即反映）
   ```
3. **Installation** で招待リンクを作り（スコープ `applications.commands`）、サーバーに追加
4. `/id` を実行。Worker の URL をブラウザで開いても進捗が見られます。

## このリポジトリのデプロイ先

- Worker: <https://discord-4id.c53gftun651-tiktok.workers.dev/>（ブラウザで開くと進捗が見られます）
- D1: `discord-4id`
- Discord Application ID: `1571403390796439564`
- スキャン: Cloudflare Workers から Discord の確認 API を叩くと **HTTP 403** で拒否されたため、`SCAN_MODE=external` にして GitHub Actions (`scan.yml`) でスキャンしています。
  リストの仕分け（再確認）も Actions が行います。
- Discord 側の設定は `.github/workflows/setup-discord.yml`（Secrets に `DISCORD_BOT_TOKEN` を入れて手動実行）

## GitHub Actions でスキャンする（任意）

Cloudflare Workers から Discord への確認リクエストがブロックされる場合（`/id` に `HTTP 403` などのエラーが出る）は、
GitHub Actions からスキャンできます。public リポジトリなら Actions は無料で使い放題です。

1. `npx wrangler secret put SCAN_SECRET`（適当な長い文字列）
2. `wrangler.toml` の `SCAN_MODE` を `"external"` にして再デプロイ（Worker 側のスキャンを止める。併用するなら `worker` のままでもOK）
3. GitHub リポジトリの Settings → Secrets and variables → Actions:
   - Secrets: `SCAN_SECRET`（1 と同じ値）
   - Variables: `SCANNER_ENABLED` = `true`、`WORKER_URL` = Worker の URL
4. `.github/workflows/scan.yml` が 10 分ごとに約 8 分スキャンします。

ローカル PC から回す場合: `WORKER_URL=... SCAN_SECRET=... npm run scan:external`

## プロキシ並列スキャン（`scripts/proxy-scan.js`）

確認APIのレート制限は **IPごと**（実測で1IPあたり約20件→約36分クールダウン）。
`external-scan.js` は1本のIP（GitHub Actionsランナー）で直列に回すので頭打りになる。
`proxy-scan.js` は無料プロキシリストを複数ソースから集め、実際にDiscordまで抜けるものだけを選別し、
**生きてるプロキシの本数だけ並列**で確認APIを叩く（＝IPを増やしてレート制限バケットを水平に増やす）。

「まず全部検証してからスキャン」という段階分けはしない。**検証班とスキャン班を同じ締切の中で同時に走らせる**:

- 検証班（既定800人）: 集めた候補（既定で全件、~55万件）を手当たり次第チェックし、生きてたら生存プールに積む
- スキャン班（既定で同時最大300本）: プールから生存プロキシを取り出し、死ぬ（3連続失敗）か締切まで
  それで撃ち続ける。死んだら即座に捨てて、プールから次の生存プロキシに差し替える
- 候補がどれだけ多くても最初の1本が生きた瞬間からスキャンが始まり、プールが尽きた・死んだ分は
  検証班が見つけ続ける新しい生存プロキシで即座に補充される

- 集めるソース: 40個（`src/proxy-pool.js` の `DEFAULT_PROXY_SOURCES`）。xyzs996, monosans, proxifly,
  ProxyScrape API, maximilianfeix, databay-labs, TheSpeedX, clarketm, ShiftyTR, jetkai, mmpx12,
  zloi-user, roosterkid, sunny9577, hendrikbgr, vakhov, MuRongPIG, Anonym0usWork1221, r00tee,
  proxy4parsing, saisuiu, B4RC0DE-TM, ALIILAPRO, a2u, Vann-Dev, proxyscrape-gh, kitzza, lumiolab,
  skyformat99, Al-kuran, iplocate, hackvice, rt45ds, b0ba67, VPSLabCloud, zebbern, xw19930, gfpcom,
  Skiddle-ID。合計で約55万件
- SOCKS5はundiciの`ProxyAgent`が対応しないため除外、HTTP/HTTPSプロキシのみ使用
- 到達性チェックは既知の取得済み名前 `discord` を投げてJSONが返るかどうか。落ちたプロキシ
  （403・タイムアウト・接続エラーが続く）は即座に切り離し、検証班が見つけた次の生存プロキシに差し替える
- 各スキャン班は自分が受け取ったレート制限ヘッダー（`x-ratelimit-*`）だけを見てペースを決める。429が来たら
  そのプロキシだけ`retry_after`待つ（他のプロキシは止まらない）。ただし残り時間より`retry_after`が長ければ
  待たずにそのプロキシを手放す
- 名前の供給・結果報告は既存の `/api/batch` `/api/report` をそのまま使う（seqの整合性はWorker側で管理）

```bash
WORKER_URL=... SCAN_SECRET=... npm run scan:proxy
```

環境変数（任意）:

| 変数 | 既定 | 説明 |
|---|---|---|
| `SCAN_DURATION_SEC` | `270` | 実行時間（秒）。検証とスキャンはこの中で同時に走る |
| `PROXY_CANDIDATE_LIMIT` | `0`（無制限） | 検証キューに入れる候補数の上限。`0`なら集めた全件（約55万件）を使う |
| `PROXY_MAX_WORKERS` | `300` | スキャン班の人数（生存プロキシの同時使用上限） |
| `PROXY_VALIDATE_CONCURRENCY` | `800` | 検証班の人数（同時に到達性チェックする数） |
| `PROXY_MAX_FAILS` | `3` | 連続失敗でそのプロキシを切る回数 |
| `SCAN_MIN_DELAY_MS` | `400` | 1プロキシあたりの最低リクエスト間隔 |
| `PROXY_PROBE_NAME` | `discord` | 到達性チェックに使う既知の取得済みユーザー名 |

GitHub Actionsの`scan.yml`から使うには、Variablesに `PROXY_SCAN=true` を設定する
（`SCANNER_ENABLED`や`WORKER_URL`は共通）。

**注意:** 無料プロキシは匿名性・安定性が保証されない（ログを見られる/改ざんされるリスクがある）。
ここで流れるのはユーザー名の空き確認リクエストだけ（認証情報もトークンも乗らない）だが、
プロキシ運営者が通信内容を記録・改変しうる前提は忘れないこと。

## 設定（wrangler.toml の `[vars]`）

| 変数 | 既定 | 説明 |
|---|---|---|
| `SCAN_LENGTHS` | `4` | 調べる文字数（`3,4` のように複数可、この順で優先） |
| `CHARSET` | `a-z0-9_.` | 使う文字。例: 数字なしにしたいなら `abcdefghijklmnopqrstuvwxyz` |
| `SCAN_BATCH` | `20` | 1回の cron で確認する件数（最大 45） |
| `SCAN_DELAY_MS` | `700` | リクエスト間隔 |
| `RECHECK_HOURS` | `6` | 「使える」の再確認間隔（時間） |
| `TAKEN_RECHECK_HOURS` | `72` | 「使えない」の再確認間隔（時間） |
| `SCAN_MODE` | `worker` | `external` で Worker の cron スキャンを停止 |

## 目安と注意

- 確認 API のレート制限は厳しく、実測で **約20件で約36分のクールダウン**が来ます。
  GitHub Actions の1回の実行で確認できるのは約20件程度なので、4文字 208万通りを1周するのは現実的ではありません（ランダム順なので、回すほど見つかる可能性が上がる形です）。
- 4文字はほとんど取られているので、見つかる数は多くありません。
- API が「空き」と返しても、予約語・禁止語などで実際には登録できない場合があります。
- この確認 API は Discord の非公開 API です。仕様変更で動かなくなる可能性があり、大量の自動アクセスは
  Discord の利用規約に抵触する恐れがあります。間隔を詰めすぎず、自己責任で使ってください。

## 開発

```bash
npm test          # Node の node:sqlite で D1 を模したテスト
npm run db:init:local && npm run dev   # ローカル起動。http://localhost:8787/__scheduled で cron を手動実行
```
