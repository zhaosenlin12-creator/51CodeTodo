/** 端到端团队链路冒烟：双成员 join / 重复加入去重 / push 指派 / 增量 pull / 成员列表 / 令牌鉴权。
 * 仅本地 127.0.0.1，不连公网。运行：node test/e2e-team.js */
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PORT = 8801;
const TOKEN = "e2e-strong-token";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "51todo-e2e-"));
const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, ACCESS_TOKEN: TOKEN },
  stdio: "ignore",
});

const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = { "Content-Type": "application/json", "x-access-token": TOKEN };

async function main() {
  await sleep(600);

  // 1) 无令牌应 401
  const noAuth = await fetch(`${base}/health`);
  if (noAuth.status !== 401) throw new Error(`无令牌期望 401，实际 ${noAuth.status}`);

  // 2) A 加入；重复同昵称加入应返回同一 memberId（去重）
  const a = await fetch(`${base}/join`, { method: "POST", headers: auth, body: JSON.stringify({ nickname: "张三" }) }).then((r) => r.json());
  const aAgain = await fetch(`${base}/join`, { method: "POST", headers: auth, body: JSON.stringify({ nickname: "张三" }) }).then((r) => r.json());
  if (!a.memberId || a.memberId !== aAgain.memberId) throw new Error("重复同昵称 join 应返回同一成员");

  // 3) B 加入
  const b = await fetch(`${base}/join`, { method: "POST", headers: auth, body: JSON.stringify({ nickname: "李四" }) }).then((r) => r.json());
  if (!b.memberId || b.memberId === a.memberId) throw new Error("B 应得到独立 memberId");

  // 4) 成员列表含 A、B 且无重复张三
  const members = await fetch(`${base}/members`, { headers: auth }).then((r) => r.json());
  const names = members.members.map((m) => m.nickname);
  if (!names.includes("张三") || !names.includes("李四")) throw new Error("成员列表缺少 A/B");
  if (names.filter((n) => n === "张三").length !== 1) throw new Error("重复加入产生了重复成员");

  // 5) A push 自己的任务并指派给 B
  const serverId = "t_e2e_001";
  const updatedAt1 = new Date().toISOString();
  const push1 = await fetch(`${base}/push`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      memberId: a.memberId,
      changes: [{ op: "upsert", task: { serverId, title: "联调任务", owner: a.memberId, assignee: b.memberId, status: "pending", rev: 1, updatedAt: updatedAt1 } }],
    }),
  }).then((r) => r.json());
  if (push1.accepted !== 1) throw new Error("指派任务未被接受");

  // 6) 全量拉取，任务 owner=A assignee=B
  const board1 = await fetch(`${base}/board?since=0`, { headers: auth }).then((r) => r.json());
  const task = board1.tasks.find((t) => t.serverId === serverId);
  if (!task || task.owner !== a.memberId || task.assignee !== b.memberId) throw new Error("任务 owner/assignee 未正确落库");

  // 7) B 增量拉取 since=0 也能看到被指派给自己的任务（筛选「我」的数据基础）
  const board2 = await fetch(`${base}/board?since=0`, { headers: auth }).then((r) => r.json());
  const mine = board2.tasks.filter((t) => t.assignee === b.memberId);
  if (mine.length !== 1) throw new Error("B 增量视角应看到被指派给自己的任务");

  // 8) B 把任务改为进行中，A 侧增量可见
  await fetch(`${base}/push`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      memberId: b.memberId,
      changes: [{ op: "upsert", task: { serverId, status: "in_progress", rev: 2, updatedAt: new Date().toISOString() } }],
    }),
  }).then((r) => r.json());
  const board3 = await fetch(`${base}/board?since=${board1.rev}`, { headers: auth }).then((r) => r.json());
  const updated = board3.tasks.find((t) => t.serverId === serverId);
  if (!updated || updated.status !== "in_progress") throw new Error("增量未拉到 B 的状态更新");

  console.log("E2E OK: 鉴权/双成员/去重/成员列表/指派/增量拉取 全部通过");
}

main()
  .catch((err) => {
    console.error("E2E FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
