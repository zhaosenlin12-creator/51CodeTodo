/** 本地冒烟测试：启动临时服务，走 join/push/board/delete 全链路。运行：node test/smoke.js */
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PORT = 8799;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "51todo-smoke-"));
const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp },
  stdio: "ignore",
});

const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await sleep(600);
  // join
  const join = await fetch(`${base}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname: "张三" }),
  }).then((r) => r.json());
  if (!join.memberId) throw new Error("join 未返回 memberId");

  // members list
  const members = await fetch(`${base}/members`).then((r) => r.json());
  if (!members.members.some((m) => m.memberId === join.memberId))
    throw new Error("members 列表未返回已加入成员");

  // push upsert
  const serverId = "t_demo_001";
  const push1 = await fetch(`${base}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      memberId: join.memberId,
      changes: [
        {
          op: "upsert",
          task: {
            serverId,
            title: "整理周报",
            owner: join.memberId,
            assignee: join.memberId,
            status: "pending",
            rev: 1,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    }),
  }).then((r) => r.json());
  if (push1.accepted !== 1) throw new Error("upsert 未被接受");

  // pull since=0
  const board1 = await fetch(`${base}/board?since=0`).then((r) => r.json());
  if (board1.tasks.length !== 1 || board1.tasks[0].title !== "整理周报")
    throw new Error("board 未返回新任务");

  // push complete (rev bump)
  await fetch(`${base}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      memberId: join.memberId,
      changes: [
        {
          op: "upsert",
          task: { serverId, status: "completed", rev: 2, updatedAt: new Date().toISOString() },
        },
      ],
    }),
  }).then((r) => r.json());

  // incremental pull since=board1.rev
  const board2 = await fetch(`${base}/board?since=${board1.rev}`).then((r) => r.json());
  const updated = board2.tasks.find((t) => t.serverId === serverId);
  if (!updated || updated.status !== "completed") throw new Error("增量未拉取到完成状态");

  // delete tombstone
  await fetch(`${base}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      memberId: join.memberId,
      changes: [{ op: "delete", serverId, updatedAt: new Date().toISOString() }],
    }),
  }).then((r) => r.json());
  const board3 = await fetch(`${base}/board?since=0`).then((r) => r.json());
  const tomb = board3.tasks.find((t) => t.serverId === serverId);
  if (!tomb || !tomb.deleted) throw new Error("删除墓碑未生效");

  console.log("SMOKE OK: join/push/upsert/增量/删除墓碑 全部通过");
}

main()
  .catch((err) => {
    console.error("SMOKE FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
