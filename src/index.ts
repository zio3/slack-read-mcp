#!/usr/bin/env node
/**
 * Slack を読み取るだけの MCP サーバー。
 *
 * 読める範囲は Bot が招待されたチャンネルのみで、これは Slack 側が決める。
 * このプログラムに権限を広げる手段はなく、書き込み系の API も呼ばない。
 */
import { createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
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

/**
 * 添付ファイルのメタデータ。中身は含まない（download_file で明示的に取る）。
 * files:read スコープが無くてもメッセージにはこの情報が付く。
 * 削除済み・非表示のファイルは mode が tombstone / hidden_by_limit になり、名前が無い。
 */
function toFile(f: any) {
  return {
    id: f.id,
    name: f.name ?? f.title,
    filetype: f.filetype,
    mimetype: f.mimetype,
    size: f.size,
    mode: f.mode,
  };
}

function toMessage(m: any) {
  return {
    ts: m.ts,
    user: m.user ?? m.bot_id,
    text: m.text,
    // 添付ファイル（画像・Excel・PDF など）の一覧。無ければ省略。
    files: m.files?.length ? m.files.map(toFile) : undefined,
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

const server = new McpServer({ name: "slack-read-mcp", version: "0.4.0" });

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
        // 添付の有無だけ。中身は get_thread_replies / get_channel_history の files で見る
        file_count: m.files?.length || undefined,
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
        // 親の添付。増分取得（oldest 付き）では親が返らないので、ここで有無だけ分かるようにする
        file_count: m.files?.length || undefined,
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

/**
 * 保存先の既定。共有の一時領域（/tmp）は他のローカルユーザーから読めるうえ、
 * 先に同名ディレクトリを作られる余地があるので使わず、ホーム配下に利用者専用で作る。
 */
const defaultDownloadDir = join(homedir(), ".cache", "slack-read-mcp");

/** 1 ファイルの上限。全量を読む前に files.info の size で弾き、サーバーをメモリ不足で落とさない。 */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** ファイル名から区切り文字・制御文字を除く（パス操作に使われないようにする）。 */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "");
  return cleaned || "file";
}

/**
 * 保存先ディレクトリを利用者専用（0700）で用意する。既にあるものがシンボリックリンクなら、
 * 別の場所へ書かされる可能性があるので使わない（Windows では mode は無視される）。
 */
function ensureDownloadDir(dir: string): string | undefined {
  if (existsSync(dir)) {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return "保存先がシンボリックリンクです";
    if (!st.isDirectory()) return "保存先がディレクトリではありません";
    // 既存のディレクトリが他のユーザーからも読める権限だと利用者専用にならない（POSIX のみ判定）
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
        return "保存先の所有者が実行ユーザーではありません";
      }
      if ((st.mode & 0o077) !== 0) return "保存先が他のユーザーからも読める権限です（chmod 700 にしてください）";
    }
    return undefined;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return undefined;
}

server.registerTool(
  "download_file",
  {
    description:
      "メッセージに添付されたファイル（画像・Excel・PDF など）を Bot トークンで取得し、ローカルに保存してパスを返す。" +
      "fileId は get_thread_replies / get_channel_history の files[].id。" +
      "Bot に files:read スコープが無いと missing_scope になる。読めるのは Bot が招待されたチャンネルのファイルだけ。" +
      "保存先は既定でホーム配下の ~/.cache/slack-read-mcp/（利用者専用）。50MB を超えるファイルは取得しない。" +
      "落としたファイルは Slack と同じ機密度で扱い、読み終えたら消すこと。",
    inputSchema: {
      fileId: z.string().describe("ファイル ID（F から始まる）"),
      outDir: z
        .string()
        .optional()
        .describe("保存先フォルダ（絶対パス）。省略時は ~/.cache/slack-read-mcp/"),
    },
  },
  async ({ fileId, outDir }) => {
    if (outDir && !isAbsolute(outDir)) {
      return fail({ error: "invalid_out_dir", needed: "outDir は絶対パスで指定してください" });
    }

    const info = await callSlack("files.info", { file: fileId });
    if (!info.ok) return fail(info);

    const f = info.file ?? {};
    const url: string | undefined = f.url_private_download ?? f.url_private;
    if (!url) {
      // 削除済み（tombstone）や外部ファイルは取得 URL を持たない
      return fail({ error: "file_not_downloadable", needed: f.mode ?? "no url_private" });
    }

    if (typeof f.size === "number" && f.size > MAX_FILE_BYTES) {
      return fail({
        error: "file_too_large",
        needed: `${MAX_FILE_BYTES} バイト以下（このファイルは ${f.size} バイト）`,
      });
    }

    const dir = outDir ?? defaultDownloadDir;
    const dirError = ensureDownloadDir(dir);
    if (dirError) return fail({ error: "invalid_out_dir", needed: dirError });

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "follow",
    });
    const contentType = res.headers.get("content-type") ?? "";
    // 権限が無いと Slack は 200 でログインページ（HTML）を返すことがある。中身を保存しても意味がないので弾く
    if (!res.ok || !res.body || (contentType.includes("text/html") && !String(f.mimetype ?? "").includes("html"))) {
      return fail({
        error: res.ok ? "file_not_accessible" : `http_${res.status}`,
        needed: "files:read スコープと、Bot がそのチャンネルに招待されていること",
      });
    }

    const name = safeFileName(f.name ?? f.title ?? fileId);
    // 既存ファイルは上書きしない（公開権限のファイルやシンボリックリンクに書かされないため）。
    // 同じファイルを再取得したときは連番を付けて新しく作る。open は 'wx'（排他作成）で行う
    const base = `${f.id ?? fileId}_${name}`;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, base.length - (name.length - dot)) : base;
    const ext = dot > 0 ? name.slice(dot) : "";
    let path = join(dir, base);
    for (let n = 1; existsSync(path) && n < 100; n++) path = join(dir, `${stem}-${n}${ext}`);
    // 排他作成で「このファイルは今回の呼び出しが作った」ことを確定させる。
    // 既に在れば（候補名が尽きた・同時実行）何も消さずに止まる
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      return fail({ error: "file_exists", needed: path });
    }
    // 全量をメモリに載せず、そのままファイルへ流す。ファイルは利用者だけが読める権限で作る
    let written = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(res.body as any),
        counter,
        createWriteStream(path, { fd }),
      );
    } catch (e) {
      // 転送途中で切れたら書きかけを残さない（残ると再試行で別名が増えるだけで気づけない）。
      // 消すのは上で自分が作ったファイルだけ
      rmSync(path, { force: true });
      return fail({ error: "download_failed", needed: String(e) });
    }

    return ok({
      id: f.id ?? fileId,
      name: f.name ?? f.title,
      mimetype: f.mimetype,
      size: written,
      path,
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
