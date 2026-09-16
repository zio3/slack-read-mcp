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
 * 設定の置き場所は ~/.config/slack-read-mcp/ を既定とする。
 * 環境変数はファイルの変更がプロセスの再起動だけで反映されない
 * （ターミナルごと再起動が要る）ため、上書き用としてのみ残す。
 */
const configDir = join(homedir(), ".config", "slack-read-mcp");

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
    reply_users_count: m.reply_users_count,
    // 最新の返信の ts。親の ts は返信が付いても動かないので、
    // スレッドの動きを検知するにはこちらを見る。
    latest_reply: m.latest_reply,
    subtype: m.subtype,
    // reactions:read スコープが無いと Slack は reactions を返さない（エラーにもならない）。
    reactions: m.reactions?.map((r: any) => ({
      name: r.name,
      count: r.count,
      users: r.users,
    })),
  };
}

/**
 * ts（"秒.マイクロ秒" の文字列）を比較する。
 * 数値に変換すると精度が落ちるので、秒とマイクロ秒を別々に整数比較する。
 */
function compareTs(a: string, b: string): number {
  const [as, au = "0"] = a.split(".");
  const [bs, bu = "0"] = b.split(".");
  const sec = Number(as) - Number(bs);
  if (sec !== 0) return sec;
  return Number(au.padEnd(6, "0")) - Number(bu.padEnd(6, "0"));
}

/**
 * 「いつから」の指定を ts に正規化する。
 * Slack の ts のほか、ISO 8601 の日時（"2026-09-16T03:00:00+09:00" など）も受け付ける。
 */
function toTs(value: string): string {
  if (/^\d+(\.\d+)?$/.test(value)) return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`since の形式が不正です: ${value}（ts か ISO 8601 の日時）`);
  }
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, "0")}`;
}

/**
 * 一覧表示用に本文を 1 行・短く切り詰める。
 * 「<@U…> <@U…>」のようにメンションだけの行は宛先であって中身ではないので飛ばし、
 * 最初の本文行を出す（すべてメンション行なら先頭行をそのまま使う）。
 */
function snippet(text: string | undefined, max = 80): string {
  const lines = (text ?? "").split("\n").filter((l) => l.trim() !== "");
  const isMentionOnly = (l: string) => l.replace(/<@[^>]+>|\s|cc:?|CC:?/gi, "") === "";
  const line = lines.find((l) => !isMentionOnly(l)) ?? lines[0] ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

/** ページ送りの上限。暴走防止で、これを超えたら truncated を立てて止める。 */
const MAX_PAGES = 10;

const server = new McpServer({ name: "slack-read-mcp", version: "0.3.0" });

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
      "各メッセージの reactions も返す（Bot に reactions:read スコープが無い場合は省略される）。" +
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
  "list_active_threads",
  {
    description:
      "since 以降に動きのあったものだけを返す巡回用ツール。" +
      "チャンネル履歴を oldest まで遡って親メッセージを集め、" +
      "(1) since より新しい投稿、(2) since より新しい返信が付いたスレッド（latest_reply で判定）を抽出する。" +
      "返信本文は含まない（動いたスレッドは get_thread_replies を oldest 付きで読む）。" +
      "本文は先頭 1 行のみに切り詰めるので、更新のないスレッドを読まされることがない。" +
      "since には前回巡回した時刻（ts か ISO 8601）を渡す。",
    inputSchema: {
      channelId: z.string().describe("チャンネル ID（C から始まる）"),
      since: z
        .string()
        .describe("この時刻より後の動きだけ返す。ts か ISO 8601 の日時（前回の巡回時刻）"),
      oldest: z
        .string()
        .optional()
        .describe(
          "履歴を遡る下限（親メッセージの ts）。監視したい最古のスレッドの親を指定する。" +
            "省略時はチャンネルの先頭まで（MAX 10 ページ = 2000 件）",
        ),
    },
  },
  async ({ channelId, since, oldest }) => {
    let sinceTs: string;
    try {
      sinceTs = toTs(since);
    } catch (e) {
      return fail({ error: "invalid_since", needed: String(e) });
    }

    const channel = normalizeChannelId(channelId);
    const parents: any[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;

    while (true) {
      const params: Record<string, string> = { channel, limit: "200" };
      if (oldest) {
        params.oldest = oldest;
        params.inclusive = "true";
      }
      if (cursor) params.cursor = cursor;

      const json = await callSlack("conversations.history", params);
      if (!json.ok) return fail(json);
      parents.push(...(json.messages ?? []));
      pages++;

      cursor = json.response_metadata?.next_cursor || undefined;
      if (!json.has_more || !cursor) break;
      if (pages >= MAX_PAGES) {
        truncated = true;
        break;
      }
    }

    const newMessages = parents
      .filter((m) => compareTs(m.ts, sinceTs) > 0)
      .map((m) => ({
        ts: m.ts,
        user: m.user ?? m.bot_id,
        text: snippet(m.text),
        reply_count: m.reply_count,
        subtype: m.subtype,
      }));

    const activeThreads = parents
      .filter(
        (m) =>
          m.reply_count > 0 &&
          typeof m.latest_reply === "string" &&
          compareTs(m.latest_reply, sinceTs) > 0,
      )
      .map((m) => ({
        thread_ts: m.ts,
        user: m.user ?? m.bot_id,
        text: snippet(m.text),
        reply_count: m.reply_count,
        reply_users_count: m.reply_users_count,
        latest_reply: m.latest_reply,
      }));

    const last = parents[parents.length - 1];
    return ok({
      since: sinceTs,
      scanned: parents.length,
      scanned_oldest_ts: last?.ts,
      truncated,
      new_messages: newMessages,
      active_threads: activeThreads,
    });
  },
);

server.registerTool(
  "get_thread_replies",
  {
    description:
      "スレッドの返信を取得する。親メッセージの ts を渡す。" +
      "oldest を渡すと、それより新しい返信だけ返す（親も含めない）。" +
      "oldest を渡さない場合は親メッセージを含めて全件返す（ページ送りで最大 2000 件）。",
    inputSchema: {
      channelId: z.string().describe("チャンネル ID"),
      threadTs: z.string().describe("親メッセージの ts"),
      oldest: z
        .string()
        .optional()
        .describe("この ts より新しい返信だけ返す（前回見た latest_reply を渡す）"),
    },
  },
  async ({ channelId, threadTs, oldest }) => {
    const channel = normalizeChannelId(channelId);
    const all: any[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;

    while (true) {
      const params: Record<string, string> = { channel, ts: threadTs, limit: "200" };
      if (oldest) params.oldest = oldest;
      if (cursor) params.cursor = cursor;

      const json = await callSlack("conversations.replies", params);
      if (!json.ok) return fail(json);
      all.push(...(json.messages ?? []));
      pages++;

      cursor = json.response_metadata?.next_cursor || undefined;
      if (!json.has_more || !cursor) break;
      if (pages >= MAX_PAGES) {
        truncated = true;
        break;
      }
    }

    // oldest 指定時は親（と oldest 以前のもの）を落とす。Slack は oldest を渡しても
    // 親メッセージを先頭に返すことがあるため、ここで揃える。
    const messages = oldest
      ? all.filter((m) => compareTs(m.ts, oldest) > 0)
      : all;

    return ok({
      count: messages.length,
      truncated,
      messages: messages.map(toMessage),
    });
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
