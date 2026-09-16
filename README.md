# slack-read-mcp

Slack を**読むだけ**の MCP サーバー。

Bot が招待されたチャンネルのメッセージを読みます。招待されていないチャンネルは、
チャンネル ID を正確に指定しても読めません。書き込みは一切できません。

サーバーもデータベースも使いません。利用者の PC 上で動き、Slack Web API を直接呼びます。
**このサーバー自体は状態を持たず、メッセージを保存しません**（取得のたびに Slack へ
問い合わせます）。

読んだ内容からタスク台帳や要約を手元に作るのは利用側の想定された使い方ですが、
全文アーカイブは作らない・転記物は元と同じ機密度で扱う、という線引きがあります。
詳細は [GUIDE.md](GUIDE.md) を参照してください。

## 設計

**権限の実体は「Bot がどのチャンネルに招待されているか」だけ**です。

- インストールしただけでは一件も読めない
- 招待を外すと、トークンを変更せずに即座に読めなくなる
- パブリック／プライベートの別は関係ない。効いているのは招待の有無だけ
- 書き込みは Slack が API レベルで拒否する（スコープを付与していないため）

チャンネル一覧を取得する権限（`channels:read`）も付与しません。したがって、
Bot は自分が招待されていないチャンネルの存在を知ることができません。
読み取り対象は設定ファイルで指定します。

**設定ファイルはアクセス制御ではありません。** そこに何を書いても、
招待されていないチャンネルは読めません。編集しても危険はありません。

## セットアップ

導入作業を AI に任せる場合は、**[INSTALL.md](INSTALL.md) を読ませてください。**
環境（Node のバージョン、Slack アプリの有無）を確認したうえで、利用者にしかできない操作だけを
依頼するよう書かれています。以下は人間が自分で作業する場合の手順です。

### 1. Slack アプリを作る

[api.slack.com/apps](https://api.slack.com/apps) → Create New App → **From a manifest** を選び、
`slack-app-manifest.json` の内容を貼り付けます。

付与されるスコープは3つだけです。

```
channels:history   参加しているパブリックチャンネルのメッセージ
groups:history     参加しているプライベートチャンネルのメッセージ
users:read         ユーザー ID から表示名への解決
```

作成後、ワークスペースへインストールして **Bot User OAuth Token**（`xoxb-` で始まる）を取得します。

### 2. Bot をチャンネルへ招待する

読みたいチャンネルで次を実行します。招待していないチャンネルは読めません。

```
/invite @slack-read-mcp
```

### 3. トークンと読み取り対象を配置する

設定はホームディレクトリの `~/.config/slack-read-mcp/` に置きます。**MCP の設定ファイルや
環境変数にトークンを書く必要はありません。**

```
~/.config/slack-read-mcp/
├── token           Bot User OAuth Token（xoxb-…）を1行だけ
└── channels.json   読み取り対象のチャンネル一覧
```

トークンは、クリップボード経由にすると**画面やコマンド履歴に出さずに**配置できます。
順序に注意してください: **①下のコマンドを先にターミナルへ貼る（実行はまだ）→
②Slack のページでトークンを Copy → ③ターミナルに戻って Enter**。
トークンをコピーした後にコマンドをコピーすると、クリップボードが上書きされて消えます。

```powershell
# Windows
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\slack-read-mcp" | Out-Null
Set-Content "$env:USERPROFILE\.config\slack-read-mcp\token" (Get-Clipboard).Trim() -NoNewline
Set-Clipboard "done"   # 本物のトークンをクリップボードに残さない
```

```bash
# macOS / Linux
mkdir -p ~/.config/slack-read-mcp && pbpaste > ~/.config/slack-read-mcp/token && echo done | pbcopy
```

AI に導入を任せる場合は、この配置は AI がクリップボードから直接行います
（[INSTALL.md](INSTALL.md) 参照。利用者はコピーだけ）。

`channels.json` は `channels.example.json` を参考に作ります。チャンネル ID は、
Slack でチャンネル名を右クリック →「リンクをコピー」で取得できます。

```json
[
  { "id": "C0123456789", "name": "team-general" }
]
```

### 4. MCP クライアントに登録する

Claude Code の場合:

```bash
claude mcp add slack-read --scope local -- npx -y github:zio3/slack-read-mcp
```

**推奨はローカルスコープ**（この Slack に関わる作業フォルダにだけ登録）です。ユーザー
スコープは全プロジェクトに常駐するため、複数の顧客・業務を扱う PC では情報の混線経路に
なります。プロジェクトスコープはリポジトリ内に `.mcp.json` を作って共有してしまうため
不適切です。

## 設定の探索順

| 設定 | 優先1（環境変数） | 優先2（ファイル） |
|---|---|---|
| トークン | `SLACK_BOT_TOKEN` | `SLACK_TOKEN_FILE` のパス → `~/.config/slack-read-mcp/token` |
| 読み取り対象 | `SLACK_CHANNELS_FILE` のパス | `~/.config/slack-read-mcp/channels.json` |

通常はファイルだけで動きます。環境変数は CI などで上書きしたい場合に使ってください。
なお環境変数を使う場合、変更は起動中のプロセスへ伝播しないため、**ターミナルごと
再起動**が必要になります。ファイル方式ならこの問題はありません（MCP クライアントの
再起動・再接続だけで反映されます）。

## ツール

| ツール | 内容 |
|---|---|
| `list_channels` | 設定ファイルに書かれた対象の一覧。Slack へは問い合わせない |
| `get_channel_history` | チャンネルのメッセージ取得。`oldest` で差分のみ取得可。スレッドの親には `latest_reply` が付く |
| `list_active_threads` | 巡回用。`since` 以降の新規投稿と、`since` 以降に返信が付いたスレッドだけを短く返す。判定はサーバー側で行うので、動きのないスレッドを読まされない |
| `get_thread_replies` | スレッド返信の取得。`oldest` で増分のみ取得可 |
| `resolve_user` | ユーザー ID を表示名・実名に解決 |

## 使う AI に読ませるもの

**[GUIDE.md](GUIDE.md) を最初に読み込ませてください。**

Slack のデータ構造には、知らないと取りこぼしに気づけない箇所があります。
特に `get_channel_history` は**スレッド返信を返しません**。これを知らずに使うと、
返信のやり取りを丸ごと見落とし、しかも見落としたことに気づけません。

## 開発

```bash
npm install
npm run build
pwsh ./test-mcp.ps1 -Tool list_channels
```

`test-mcp.ps1` は MCP サーバーを素の JSON-RPC で叩く確認用スクリプトです。

ビルドを挟まず TypeScript のまま実行することもできます（Node 22.6 以降）。

```bash
npm run start:ts        # Node 22.6〜23.5（--experimental-strip-types 付き）
node src/index.ts       # Node 23.6 以降（フラグ不要）
```

配布時にビルド方式を既定にしているのは、実行環境の Node バージョンに依存させないためです。
型ストリッピングはまだ experimental で、stderr に警告が出ます。

## ライセンス

MIT
