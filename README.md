# slack-read-mcp

Slack を**読むだけ**の MCP サーバー。

Bot が招待されたチャンネルのメッセージを読みます。招待されていないチャンネルは、
チャンネル ID を正確に指定しても読めません。書き込みは一切できません。

サーバーもデータベースも使いません。利用者の PC 上で動き、Slack Web API を直接呼びます。
メッセージをどこかへ保存することもありません。

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

### 3. 読み取り対象を設定する

`channels.example.json` を参考に、対象チャンネルを列挙したファイルを作ります。
チャンネル ID は、Slack でチャンネル名を右クリック →「リンクをコピー」で取得できます。

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

トークンは**設定ファイルに書かず**、環境変数で渡します。

```powershell
# Windows（一度実行すれば以降は不要。クリップボードにトークンをコピーしてから）
[Environment]::SetEnvironmentVariable("SLACK_BOT_TOKEN", (Get-Clipboard).Trim(), "User")
[Environment]::SetEnvironmentVariable("SLACK_CHANNELS_FILE", "C:\path\to\channels.json", "User")
```

```bash
# macOS / Linux
export SLACK_BOT_TOKEN='xoxb-...'
export SLACK_CHANNELS_FILE="$HOME/.config/slack-read-mcp/channels.json"
```

環境変数の設定後、MCP クライアントを再起動してください。

## 環境変数

| 変数 | 必須 | 内容 |
|---|---|---|
| `SLACK_BOT_TOKEN` | 必須 | Bot User OAuth Token（`xoxb-`） |
| `SLACK_CHANNELS_FILE` | 任意 | 読み取り対象を書いた JSON のパス。未指定なら `list_channels` は空を返す |

## ツール

| ツール | 内容 |
|---|---|
| `list_channels` | 設定ファイルに書かれた対象の一覧。Slack へは問い合わせない |
| `get_channel_history` | チャンネルのメッセージ取得。`oldest` で差分のみ取得可 |
| `get_thread_replies` | スレッド返信の取得 |
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
