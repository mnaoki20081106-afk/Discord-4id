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
  - 3文字: 54,872 通り / 4文字: 2,085,136 通り
- 先頭から順番に調べると偏るので、周回ごとにシャッフルした順番で**全組み合わせを1回ずつ**確認します。
- `SCAN_LENGTHS="3,4"` の順に1周ずつ回ります（3文字を1周 → 4文字を1周 → 3文字を2周目 …）。
- 確認には Discord の登録画面が使っている
  `POST /api/v9/unique-username/username-attempt-unauthed` を使います（**ユーザートークン不要**、セルフBotにはしていません）。
- 429（レート制限）が返ったら `retry_after` の時間だけ必ず休みます。
- 「空き」と判定した名前は `RECHECK_HOURS` ごとに再確認し、取られていたら一覧から消します。

## /id コマンド

| オプション | 説明 |
|---|---|
| `length` | `3文字` / `4文字` / `すべて` |
| `count`  | 表示件数（1〜100、既定 20） |
| `verify` | 送信前にいま空いているか再確認（最大10件。取られていたら除外） |
| `random` | ランダムに選ぶ |
| `hidden` | 自分だけに表示 |

返信には一覧のほか、スキャンの進捗（何周目の何%か）・空きの件数・最後のエラーも表示されます。
サーバーにも、ユーザーインストール（DMなど）にも対応しています。

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

## 設定（wrangler.toml の `[vars]`）

| 変数 | 既定 | 説明 |
|---|---|---|
| `SCAN_LENGTHS` | `3,4` | 調べる文字数（この順で優先） |
| `CHARSET` | `a-z0-9_.` | 使う文字。例: 数字なしにしたいなら `abcdefghijklmnopqrstuvwxyz` |
| `SCAN_BATCH` | `20` | 1回の cron で確認する件数（最大 45） |
| `SCAN_DELAY_MS` | `700` | リクエスト間隔 |
| `RECHECK_HOURS` | `12` | 空き名の再確認間隔 |
| `SCAN_MODE` | `worker` | `external` で Worker の cron スキャンを停止 |

## 目安と注意

- 既定設定（毎分20件）だと 1日 約 2.8 万件 → **3文字は約2日、4文字は約2〜3ヶ月で1周**です。
  確認 API のレート制限次第で前後します。
- 3〜4文字はほとんど取られているので、見つかる数は多くありません。空きはすぐ取られるので `verify` 付きで確認がおすすめです。
- API が「空き」と返しても、予約語・禁止語などで実際には登録できない場合があります。
- この確認 API は Discord の非公開 API です。仕様変更で動かなくなる可能性があり、大量の自動アクセスは
  Discord の利用規約に抵触する恐れがあります。間隔を詰めすぎず、自己責任で使ってください。

## 開発

```bash
npm test          # Node の node:sqlite で D1 を模したテスト
npm run db:init:local && npm run dev   # ローカル起動。http://localhost:8787/__scheduled で cron を手動実行
```
