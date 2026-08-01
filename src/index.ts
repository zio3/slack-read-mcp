#!/usr/bin/env node
/**
 * Slack を読み取るだけの MCP サーバー。
 *
 * 読める範囲は Bot が招待されたチャンネルのみで、これは Slack 側が決める。
 * このプログラムに権限を広げる手段はなく、書き込み系の API も呼ばない。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * 設定の置き場所は ~/.slack-read-mcp/ を既定とする。
 * 環境変数はファイルの変更がプロセスの再起動だけで反映されない
 * （ターミナルごと再起動が要る）ため、上書き用としてのみ残す。
 */
const configDir = join(homedir(), ".slack-read-mcp");

function loadToken(): string | undefined {
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;
  const tokenFile = process.env.SLACK_TOKEN_FILE ?? join(configDir, "token");
  if (existsSync(tokenFile)) {
    return readFileSync(tokenFile, "utf8").trim();
  }
  return undefined;
}

const token = loadToken();
if (!token) {
  console.error(
    `Bot Token が見つかりません。${join(configDir, "token")} に置くか、` +
      "環境変数 SLACK_BOT_TOKEN を設定してください。",
  );
  process.exit(1);
}

/** 読み取り対象のチャンネル。権限ではなく、読みに行く先の一覧にすぎない。 */
type ChannelEntry = { id: string; name?: string; note?: string };

/**
 * チャンネル ID を取り出す。素の ID のほか、Slack の URL
 * （…/archives/C… や app.slack.com/client/T…/C…）を貼られても動くようにする。
 * name は表示用のラベルにすぎず、読み取りは ID だけで行われる。
 */
function normalizeChannelId(value: string): string {
  const ids = value.match(/[CG][A-Z0-9]{7,}/g);
  return ids ? ids[ids.length - 1] : value;
}

function loadChannels(): ChannelEntry[] {
  const path =
    process.env.SLACK_CHANNELS_FILE ?? join(configDir, "channels.json");
  if (!existsSync(path)) return [];
  try {
    const entries = JSON.parse(readFileSync(path, "utf8")) as ChannelEntry[];
    return entries.map((e) => ({ ...e, id: normalizeChannelId(e.id) }));
  } catch (e) {
    console.error(`channels ファイルを読めませんでした (${path}): ${e}`);
    return [];
  }
}

const channels = loadChannels();

/**
 * Slack Web API を呼ぶ。
 * Slack は権限不足でも HTTP 200 を返し、本文の ok / error で失敗を伝える。
 */
async function callSlack(
  method: string,
  params: Record<string, string>,
): Promise<any> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

/**
 * 読めなかった理由を握り潰さずそのまま返す。
 * not_in_channel / channel_not_found / missing_scope の区別は、
 * 利用者が「招待すれば解決する」と判断するために必要になる。
 */
function fail(json: any) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { ok: false, error: json.error ?? "unknown_error", needed: json.needed },
          null,
          2,
        ),
      },
    ],
  };
}

function ok(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function toMessage(m: any) {
  return {
    ts: m.ts,
    user: m.user ?? m.bot_id,
    text: m.text,
    // thread_ts === ts ならスレッドの親。異なればスレッド返信。
    thread_ts: m.thread_ts,
    reply_count: m.reply_count,
    subtype: m.subtype,
  };
}

const server = new McpServer({ name: "slack-read-mcp", version: "0.1.0" });

server.registerTool(
  "list_channels",
  {
    description:
      "読み取り対象として設定されているチャンネルの一覧を返す。Slack へは問い合わせない。" +
      "ここに載っていても Bot が招待されていなければ読めない。",
    inputSchema: {},
  },
  async () => ok({ count: channels.length, channels }),
);

server.registerTool(
  "get_channel_history",
  {
    description:
      "チャンネルのメッセージを新しい順に取得する。oldest に前回の ts を渡すと差分だけ取れる。" +
      "スレッド返信は含まれない（reply_count > 0 のメッセージには get_thread_replies が必要）。" +
      "Bot が参加していない場合は not_in_channel または channel_not_found になる。",
    inputSchema: {
      channelId: z.string().describe("チャンネル ID（C から始まる）"),
      limit: z.number().int().min(1).max(200).default(50).describe("取得件数"),
      oldest: z.string().optional().describe("この ts より新しいメッセージのみ取得する"),
    },
  },
  async ({ channelId, limit, oldest }) => {
    const params: Record<string, string> = {
      channel: normalizeChannelId(channelId),
      limit: String(limit),
    };
    if (oldest) params.oldest = oldest;

    const json = await callSlack("conversations.history", params);
    if (!json.ok) return fail(json);

    const messages: any[] = json.messages ?? [];
    return ok({
      count: messages.length,
      has_more: json.has_more ?? false,
      messages: messages.map(toMessage),
    });
  },
);

server.registerTool(
  "get_thread_replies",
  {
    description:
      "スレッドの返信を取得する。親メッセージの ts を渡す。返り値には親メッセージも含まれる。",
    inputSchema: {
      channelId: z.string().describe("チャンネル ID"),
      threadTs: z.string().describe("親メッセージの ts"),
    },
  },
  async ({ channelId, threadTs }) => {
    const json = await callSlack("conversations.replies", {
      channel: normalizeChannelId(channelId),
      ts: threadTs,
      limit: "200",
    });
    if (!json.ok) return fail(json);

    const messages: any[] = json.messages ?? [];
    return ok({ count: messages.length, messages: messages.map(toMessage) });
  },
);

server.registerTool(
  "resolve_user",
  {
    description:
      "ユーザー ID を表示名・実名に解決する。本文中の <@U…> を人名に直すのに使う。",
    inputSchema: {
      userId: z.string().describe("ユーザー ID（U から始まる）"),
    },
  },
  async ({ userId }) => {
    const json = await callSlack("users.info", { user: userId });
    if (!json.ok) return fail(json);

    const u = json.user;
    return ok({
      id: u.id,
      name: u.name,
      real_name: u.profile?.real_name,
      display_name: u.profile?.display_name,
      is_bot: u.is_bot,
    });
  },
);

await server.connect(new StdioServerTransport());
