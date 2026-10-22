/** 安全与边界测试：令牌全覆盖、非法 JSON/数组/超大 body、坏 ID、陈旧更新、字段白名单、损坏数据文件。
 * 仅本地 127.0.0.1，不连公网；DATA_DIR 走临时目录，不污染 server/data。运行：node test/security-edge.js */
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PORT = 8802;
const TOKEN = "edge-strong-token-9f3a7c";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "51todo-edge-"));
const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, ACCESS_TOKEN: TOKEN },
  stdio: "ignore",
});

// 损坏数据文件场景：单独起一个服务，预置坏 JSON，期望 /health 返回 500 而不是被空板覆盖。
const corruptTmp = fs.mkdtempSync(path.join(os.tmpdir(), "51todo-corrupt-"));
fs.writeFileSync(path.join(corruptTmp, "board.json"), "{这不是合法JSON", "utf8");
const PORT2 = 8803;
const child2 = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
  env: { ...process.env, PORT: String(PORT2), DATA_DIR: corruptTmp, ACCESS_TOKEN: TOKEN },
  stdio: "ignore",
});

const base = `http://127.0.0.1:${PORT}`;
const base2 = `http://127.0.0.1:${PORT2}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = { "Content-Type": "application/json", "x-access-token": TOKEN };

let checks = 0;
function check(cond, label) {
  checks += 1;
  if (!cond) throw new Error(`检查失败 #${checks}: ${label}`);
}

async function main() {
  await sleep(700);

  // 1) 令牌全覆盖：无令牌/错令牌 401；带头 200；?token= 查询参数 200
  check((await fetch(`${base}/health`)).status === 401, "无令牌 /health 应 401");
  check((await fetch(`${base}/health`, { headers: { "x-access-token": "wrong" } })).status === 401, "错令牌应 401");
  check((await fetch(`${base}/health`, { headers: auth })).status === 200, "正确令牌头应 200");
  check((await fetch(`${base}/health?token=${encodeURIComponent(TOKEN)}`)).status === 200, "?token= 查询令牌应 200");

  // 2) 非法 JSON / 数组 body / 空昵称 → 400
  const badJson = await fetch(`${base}/join`, { method: "POST", headers: auth, body: "{not json" });
  check(badJson.status === 400, "非法 JSON 应 400");
  const arrBody = await fetch(`${base}/join`, { method: "POST", headers: auth, body: JSON.stringify([1, 2]) });
  check(arrBody.status === 400, "数组 body 应 400");
  const emptyNick = await fetch(`${base}/join`, { method: "POST", headers: auth, body: JSON.stringify({ nickname: "   " }) });
  check(emptyNick.status === 400, "空白昵称应 400");

  // 3) 合法 join
  const me = await fetch(`${base}/join`, { method: "POST", headers: auth, body: JSON.stringify({ nickname: "王五" }) }).then((r) => r.json());
  check(me.memberId, "合法 join 返回 memberId");

  // 4) memberId 类型错误 → 400
  check(
    (await fetch(`${base}/push`, { method: "POST", headers: auth, body: JSON.stringify({ memberId: 123, changes: [] }) })).status === 400,
    "memberId 非字符串应 400"
  );

  // 5) 未知 op 被拒绝，rev 不变
  const before = await fetch(`${base}/board?since=0`, { headers: auth }).then((r) => r.json());
  const unknownOp = await fetch(`${base}/push`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ memberId: me.memberId, changes: [{ op: "archive", serverId: "x" }] }),
  }).then((r) => r.json());
  check(unknownOp.accepted === 0 && unknownOp.rejected === 1, "未知 op 应 rejected=1");
  check(unknownOp.rev === before.rev, "未知 op 不应推进 rev");

  // 6) 危险/非法 serverId（__proto__、路径分隔、斜杠）全部拒绝且不落库、不崩溃
  const badIds = ["__proto__", "../evil", "a/b", "has\\backslash", ""];
  const badPush = await fetch(`${base}/push`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      memberId: me.memberId,
      changes: badIds.map((id) => ({ op: "upsert", task: { serverId: id, title: "x", rev: 1, updatedAt: new Date().toISOString() } })),
    }),
  }).then((r) => r.json());
  check(badPush.accepted === 0 && badPush.rejected === badIds.length, `非法 serverId 应全拒绝（${badIds.length}）`);

  // 7) 合法 upsert；再推一条更旧 updatedAt → 被拒，原任务不变；注入字段不落库
  const t0 = "2026-01-01T00:00:00.000Z";
  const good = await fetch(`${base}/push`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      memberId: me.memberId,
      changes: [{ op: "upsert", task: { serverId: "t_sec_001", title: "安全用例", note: "n", customerName: "c", status: "pending", rev: 1, updatedAt: t0, isAdmin: true, deleted: true } }],
    }),
  }).then((r) => r.json());
  check(good.accepted === 1, "合法 upsert accepted=1");
  const board = await fetch(`${base}/board?since=0`, { headers: auth }).then((r) => r.json());
  const task = board.tasks.find((t) => t.serverId === "t_sec_001");
  check(task && task.title === "安全用例", "任务已落库");
  check(task.isAdmin === undefined && task.deleted === undefined, "注入字段 isAdmin/deleted 不落库（白名单）");

  const stale = await fetch(`${base}/push`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      memberId: me.memberId,
      changes: [{ op: "upsert", task: { serverId: "t_sec_001", title: "更旧的覆盖", status: "completed", rev: 9, updatedAt: "2025-12-31T00:00:00.000Z" } }],
    }),
  }).then((r) => r.json());
  check(stale.accepted === 0 && stale.rejected === 1, "更旧 updatedAt 应被拒绝");
  const board2 = await fetch(`${base}/board?since=0`, { headers: auth }).then((r) => r.json());
  const task2 = board2.tasks.find((t) => t.serverId === "t_sec_001");
  check(task2.title === "安全用例" && task2.status === "pending", "陈旧更新未覆盖原任务");

  // 8) since 非数字不崩溃
  check((await fetch(`${base}/board?since=abc`, { headers: auth })).status === 200, "since=abc 应 200 不崩溃");

  // 9) 超大 body → 413（个别栈会直接断连，二者都算通过）
  let largeOk = false;
  try {
    const r = await fetch(`${base}/push`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ memberId: me.memberId, pad: "x".repeat(1_100_000), changes: [] }),
    });
    largeOk = r.status === 413;
  } catch (_e) {
    largeOk = true; // 连接被切断也算服务端拒绝了超大 body
  }
  check(largeOk, "超大 body 应被拒绝（413 或断连）");

  // 10) 损坏的 board.json：/health 返回 500，而不是被空板静默覆盖
  const corruptHealth = await fetch(`${base2}/health`, { headers: auth });
  check(corruptHealth.status === 500, "损坏 board.json 应 500，拒绝静默重置");

  console.log(`EDGE OK: ${checks} 项检查全部通过（令牌/400/413/坏ID/陈旧更新/白名单/损坏文件）`);
}

main()
  .catch((err) => {
    console.error("EDGE FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill();
    child2.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(corruptTmp, { recursive: true, force: true });
  });
