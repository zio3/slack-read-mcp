# 導入手順（AI 向け）

この文書は、**利用者に代わって導入作業を行う AI** に向けたものです。
人間向けの説明は [README.md](README.md) を参照してください。

利用者は「Slack を読めるようにして」程度の依頼しかしません。
環境を確認し、適切な方式を選び、**利用者にしかできない操作だけを依頼**してください。

## 大原則

**トークンを会話に出させない。** 利用者に「トークンを貼ってください」と言ってはいけません。
クリップボード経由で環境変数へ入れてもらいます（手順は後述）。

**Slack 側の操作は利用者が行う。** アプリの作成・インストール・チャンネルへの招待は、
ブラウザでの操作と権限が要ります。AI が代行しようとしないでください。

## 手順1: 前提を確認する

```bash
node --version
```

Node.js が無ければ、利用者にインストールを依頼してください。v18 以上が必要です。

次に、Slack アプリが用意済みかを確認します。利用者に尋ねてください。

- Slack アプリを作成済みか
- Bot User OAuth Token（`xoxb-` で始まる）を持っているか
- 読みたいチャンネルに Bot を招待済みか

未了なら手順2へ、済んでいれば手順3へ進みます。

## 手順2: Slack アプリを用意してもらう

**この作業は利用者が行います。** 次を提示してください。

1. [api.slack.com/apps](https://api.slack.com/apps) を開く
2. **Create New App** → **From a manifest** を選ぶ
3. ワークスペースを選び、`slack-app-manifest.json` の内容を貼り付ける
4. **Create** → **Install to Workspace** → 許可する
5. **OAuth & Permissions** に表示される **Bot User OAuth Token**（`xoxb-…`）を控える
6. 読みたいチャンネルで `/invite @slack-read-mcp` を実行する

補足として伝えるとよいこと。

- 招待していないチャンネルは読めません。**インストールしただけでは一件も読めません**
- プライベートチャンネルも、招待すれば読めます。招待しなければ存在も見えません
- Slack フリープランはインストールできるアプリが10個までです。上限に達している場合、不要なアプリを1つ外す必要があります

## 手順3: 起動方式を決める

`node --version` の結果で分岐します。**利用者に聞かず、AI が判断してください。**

| Node のバージョン | 方式 | 起動コマンド |
|---|---|---|
| v23.6 以上 | TypeScript を直接実行 | `node src/index.ts` |
| v22.6 〜 v23.5 | TypeScript を直接実行（フラグ付き） | `node --experimental-strip-types src/index.ts` |
| v18 〜 v22.5 | ビルドしてから実行 | `npm install && npm run build` → `node dist/index.js` |

**迷ったらビルド方式を選んでください。** どのバージョンでも動きます。

TypeScript の直接実行は experimental のため、stderr に警告が出ます。MCP は stdout を使うので
動作に支障はありませんが、利用者が驚かないよう一言伝えてください。

なお、リポジトリから直接取得して実行する方式（`npx -y github:zio3/slack-read-mcp`）も使えます。
この場合は取得時に自動でビルドされるため、上記の分岐は不要です。ネットワーク経由の取得を
避けたい環境では、クローンしてローカルパスを指定してください。

## 手順4: 読み取り対象を設定する

`channels.example.json` を参考に、対象チャンネルを列挙した JSON を作ります。
置き場所は利用者の設定ディレクトリが適切です（リポジトリ内に置かないでください）。

```json
[
  { "id": "C0123456789", "name": "team-general" }
]
```

チャンネル ID の調べ方を利用者に伝えてください。Slack でチャンネル名を右クリック →
「リンクをコピー」→ URL 末尾の `C` から始まる文字列です。

**この設定ファイルはアクセス制御ではありません。** ここに何を書いても、Bot が招待されて
いないチャンネルは読めません。利用者が自由に編集して構わない旨を伝えてください。

## 手順5: トークンを設定してもらう

**利用者に実行してもらいます。AI が代わりに実行しないでください。**
トークンをコピーした状態で、次を実行するよう伝えます。

Windows:

```powershell
[Environment]::SetEnvironmentVariable("SLACK_BOT_TOKEN", (Get-Clipboard).Trim(), "User")
[Environment]::SetEnvironmentVariable("SLACK_CHANNELS_FILE", "<channels.json のパス>", "User")
```

macOS / Linux（シェルの設定ファイルへ追記）:

```bash
echo 'export SLACK_BOT_TOKEN="<ここに貼る>"' >> ~/.zshrc
echo 'export SLACK_CHANNELS_FILE="$HOME/.config/slack-read-mcp/channels.json"' >> ~/.zshrc
```

クリップボード経由にするのは、**トークンがコマンド履歴や会話ログに残らないようにするため**です。
利用者がトークンを会話に貼ろうとしたら、止めて上記を案内してください。
すでに貼られてしまった場合は、**Slack アプリの Reinstall でトークンを再発行する**よう伝えてください。

## 手順6: MCP クライアントへ登録する

Claude Code の場合（スコープは共有可能性に応じて選ぶ）:

```bash
claude mcp add slack-read --scope local -- npx -y github:zio3/slack-read-mcp
```

ローカルのクローンを使う場合:

```bash
claude mcp add slack-read --scope local -- node /path/to/slack-read-mcp/dist/index.js
```

**トークンを MCP の設定ファイルに書かないでください。** 環境変数から読みます。
設定ファイルに平文で残すと、リポジトリや設定の共有時に漏れます。

環境変数を設定した直後は、**MCP クライアントの再起動が必要**です（起動中のプロセスは
新しい環境変数を引き継ぎません）。利用者に再起動を依頼してください。

## 手順7: 動作を確認する

再起動後、次の順で確認します。

1. `list_channels` … 設定ファイルの内容が返るか
2. `get_channel_history` … 招待済みチャンネルのメッセージが読めるか

エラーが出た場合、原因は次のいずれかです。

| エラー | 原因 | 対処 |
|---|---|---|
| `not_in_channel` | パブリックチャンネルに Bot が招待されていない | 利用者に `/invite` を依頼 |
| `channel_not_found` | プライベートチャンネルで未招待、または ID が誤り | 同上。ID も確認 |
| `missing_scope` | 権限が付与されていない操作を呼んだ | 仕様。回避しようとしない |
| `invalid_auth` / `account_inactive` | トークンが無効、またはアプリがアンインストール済み | 再インストールとトークン再取得を依頼 |
| サーバーが起動しない | `SLACK_BOT_TOKEN` が渡っていない | 環境変数の設定と、クライアントの再起動を確認 |

**読めなかった理由を推測で埋めないでください。** エラーをそのまま伝えれば、利用者は
招待や再設定で解決できます。

## 導入後

利用者の AI（あなた自身、または後で使われる AI）に、**[GUIDE.md](GUIDE.md) を読ませてください。**

Slack のデータ構造には、知らないと取りこぼしに気づけない箇所があります。特に
`get_channel_history` はスレッド返信を返しません。これを知らずに使うと、返信のやり取りを
丸ごと見落とし、しかも見落としたことに気づけません。
