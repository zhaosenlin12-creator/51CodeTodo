/**
 * 51CodeTodo 团队同步服务端（零依赖，仅用 Node.js 内置模块）。
 *
 * 设计：公网部署在宝塔（Node 项目 + PM2），本机与云端同构。
 * 持久化：data/board.json（小团队够用；原子写入，崩溃不写坏）。
 * 鉴权：若设置环境变量 ACCESS_TOKEN，则所有请求需带 `x-access-token` 或 ?token=；
 *       不设置则开放（仅适合内网/可信环境，公网务必设置）。
 *
 * 接口：
 *   GET  /health
 *   POST /join            { nickname }                 -> member（同昵称重复加入返回已存在成员）
 *   GET  /members                                          -> 成员列表
 *   GET  /board?since=N                                -> { rev, members, tasks[] }
 *   POST /push            { memberId, changes[] }      -> { rev, accepted, rejected }
 *
 * change: { op:"upsert", task:{...} } | { op:"delete", serverId, updatedAt }
 * 合并：按 updatedAt 先比较、同刻以 rev 大者为准（最后写入胜出）；删除写墓碑。
 * 安全：设置 ACCESS_TOKEN 后所有接口（含 GET）均需令牌；任务 ID 限字母数字/_-，upsert 字段白名单。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 默认端口取 ≥3100 的 3170，避开服务器上常见的 3000；可用环境变量 PORT 覆盖。
const PORT = Number(process.env.PORT || 3170);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`PORT 非法：${process.env.PORT}，应为 1-65535 的整数`);
  process.exit(1);
}
const HOST = process.env.HOST || "0.0.0.0";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const BOARD_FILE = path.join(DATA_DIR, "board.json");
const MAX_BODY = 1_000_000;
const MAX_CHANGES = 500;
// 任务 ID 只允许字母开头、字母数字/下划线/连字符，拒绝 __proto__、路径分隔符等危险键。
const SERVER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
// upsert 允许落库的业务字段；serverId/rev/updatedAt/deleted 由服务端掌握，客户端不可注入。
const TASK_FIELDS = ["title", "note", "customerName", "status", "assignee", "owner", "dueAt"];

// 写操作（/join、/push）串行化，避免两次并发 load→save 之间互相覆盖（丢失更新）。
let writeChain = Promise.resolve();
function withWrite(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function emptyBoard() {
  return { rev: 0, members: {}, tasks: {} };
}

function loadBoard() {
  ensureDir();
  let raw;
  try {
    raw = fs.readFileSync(BOARD_FILE, "utf8");
  } catch (err) {
    // 文件不存在 = 全新空板；其他读取错误（权限/磁盘）直接抛出，交给上层返回 500。
    if (err && err.code === "ENOENT") return emptyBoard();
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // 文件损坏：绝不静默按空板处理后回写覆盖（那会毁掉现有数据），直接报错让人工介入。
    throw new Error("board.json 解析失败，数据文件可能损坏，已拒绝覆盖：" + err.message);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyBoard();
  parsed.members = parsed.members && typeof parsed.members === "object" && !Array.isArray(parsed.members) ? parsed.members : {};
  parsed.tasks = parsed.tasks && typeof parsed.tasks === "object" && !Array.isArray(parsed.tasks) ? parsed.tasks : {};
  parsed.rev = Number(parsed.rev) || 0;
  return parsed;
}

function saveBoard(board) {
  ensureDir();
  const tmp = BOARD_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(board), "utf8");
  fs.renameSync(tmp, BOARD_FILE);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-access-token",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(body);
}

function makeHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.pause();
        reject(makeHttpError(413, "请求体过大（上限 1MB）"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch (err) {
        return reject(makeHttpError(400, "请求体不是合法 JSON：" + err.message));
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return reject(makeHttpError(400, "请求体必须是 JSON 对象"));
      }
      resolve(parsed);
    });
    req.on("error", reject);
  });
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return crypto.timingSafeEqual(ba, bb);
}

function authorized(req) {
  if (!ACCESS_TOKEN) return true;
  const header = req.headers["x-access-token"];
  const url = new URL(req.url, "http://x");
  return safeEqual(header, ACCESS_TOKEN) || safeEqual(url.searchParams.get("token"), ACCESS_TOKEN);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-access-token",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    return res.end();
  }
  if (!authorized(req)) return json(res, 401, { error: "未授权" });

  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      const board = loadBoard();
      return json(res, 200, { ok: true, rev: board.rev });
    }

    if (req.method === "POST" && url.pathname === "/join") {
      const body = await readBody(req);
      // 去掉控制字符与首尾空白，截断 24 字；纯空白/空昵称拒绝。
      const nickname = String(body.nickname ?? "")
        .replace(/[\x00-\x1f\x7f]/g, "")
        .trim()
        .slice(0, 24);
      if (!nickname) return json(res, 400, { error: "昵称不能为空" });
      await withWrite(() => {
        const board = loadBoard();
        // 同昵称重复加入返回已有成员，避免反复点「加入团队」刷出重复成员。
        const existing = Object.values(board.members).find((m) => m.nickname === nickname);
        if (existing) {
          json(res, 200, existing);
          return;
        }
        const member = { memberId: newId("m"), nickname, joinedAt: new Date().toISOString() };
        board.members[member.memberId] = member;
        saveBoard(board);
        json(res, 200, member);
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/members") {
      const board = loadBoard();
      return json(res, 200, { members: Object.values(board.members) });
    }

    if (req.method === "GET" && url.pathname === "/board") {
      const rawSince = Number(url.searchParams.get("since") || 0);
      const since = Number.isFinite(rawSince) && rawSince >= 0 ? Math.floor(rawSince) : 0;
      const board = loadBoard();
      const tasks = Object.values(board.tasks).filter((t) => t.rev > since);
      return json(res, 200, {
        rev: board.rev,
        members: Object.values(board.members),
        tasks,
      });
    }

    if (req.method === "POST" && url.pathname === "/push") {
      const body = await readBody(req);
      if (body.memberId !== undefined && typeof body.memberId !== "string") {
        return json(res, 400, { error: "memberId 必须是字符串" });
      }
      const changes = Array.isArray(body.changes) ? body.changes.slice(0, MAX_CHANGES) : [];
      await withWrite(() => {
        const board = loadBoard();
        let accepted = 0;
        let rejected = 0;
        for (const change of changes) {
          if (!change || typeof change !== "object" || Array.isArray(change)) {
            rejected += 1;
            continue;
          }
          if (change.op === "upsert") {
            const task = change.task;
            const serverId = task && typeof task === "object" ? String(task.serverId || "") : "";
            if (!SERVER_ID_RE.test(serverId)) {
              rejected += 1;
              continue;
            }
            const existing = board.tasks[serverId];
            const incomingRev = Number(task.rev) || 0;
            const incomingTime = String(task.updatedAt || "");
            const existingTime = existing ? String(existing.updatedAt || "") : "";
            // 时间先于 rev：更旧的更新不覆盖；同刻以 rev 大者为准（与客户端 should_accept_remote 一致）。
            if (existing) {
              if (incomingTime && existingTime && incomingTime < existingTime) {
                rejected += 1;
                continue;
              }
              if (incomingTime === existingTime && incomingRev < existing.rev) {
                rejected += 1;
                continue;
              }
            }
            board.rev += 1;
            const fields = {};
            for (const k of TASK_FIELDS) {
              if (task[k] !== undefined) fields[k] = task[k];
            }
            board.tasks[serverId] = {
              ...existing,
              ...fields,
              serverId,
              rev: board.rev,
              updatedAt: incomingTime || new Date().toISOString(),
            };
            accepted += 1;
          } else if (change.op === "delete") {
            const serverId = String(change.serverId || "");
            if (!SERVER_ID_RE.test(serverId)) {
              rejected += 1;
              continue;
            }
            const existing = board.tasks[serverId];
            if (!existing || existing.deleted) {
              rejected += 1;
              continue;
            }
            board.rev += 1;
            board.tasks[serverId] = {
              ...existing,
              deleted: true,
              rev: board.rev,
              updatedAt: String(change.updatedAt || new Date().toISOString()),
            };
            accepted += 1;
          } else {
            rejected += 1;
          }
        }
        saveBoard(board);
        json(res, 200, { rev: board.rev, accepted, rejected });
      });
      return;
    }

    return json(res, 404, { error: "接口不存在" });
  } catch (err) {
    const status = typeof err.status === "number" ? err.status : 500;
    return json(res, status, { error: err.message || "服务器错误" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`51CodeTodo sync server listening on http://${HOST}:${PORT}`);
});
