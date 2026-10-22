# 51CodeTodo 同步服务端 · 宝塔部署说明

零依赖（只用 Node.js 内置模块），**不需要 npm install、不需要编译**。推荐宝塔面板 Node 项目 + PM2 常驻。

> 客户端安全限制：只允许 `https://` 地址，或本机回环 `http://127.0.0.1` / `http://localhost` 联调；**公网直连 `http://IP:端口` 会被客户端拒绝**，所以公网必须走下面第四节的域名 + HTTPS 反向代理。

## 一、环境要求
- 服务器已装宝塔面板；
- Node.js ≥ 18（宝塔「软件商店」安装 Node.js 版本管理器，装一个 18/20/22 即可）；
- 端口：默认 **3170**。约定使用 ≥3100 的端口（避开服务器上已占用的 3000 等常见端口），也可在配置里改成其他空闲端口；走反向代理时对外只需放行 80/443，3170 仅本机回环使用、不必对公网开放。
- 环境变量一览：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3170` | 监听端口，1–65535 整数 |
| `HOST` | `0.0.0.0` | 走 Nginx 反代建议设为 `127.0.0.1`，只监听回环 |
| `ACCESS_TOKEN` | 空（开放） | 访问令牌；**公网必须设置** |
| `DATA_DIR` | `./data` | board.json 所在目录，一般不改 |

## 二、上传与启动（PM2）
1. 把整个 `server/` 目录上传到服务器，例如 `/www/wwwroot/51codetodo-sync/`（不要上传 `data/`、`node_modules/`、日志文件；`data/` 首次启动会自动创建）。
2. 宝塔「终端」进入目录：
   ```bash
   cd /www/wwwroot/51codetodo-sync
   ```
3. 设置强访问令牌，防止任何人读写。两种启动方式二选一：

   **方式 A：ecosystem 配置常驻（推荐）**
   编辑自带的 `ecosystem.config.js`，把 `ACCESS_TOKEN` 占位符换成自己的强随机令牌，按需改 `PORT`、`HOST`，然后：
   ```bash
   pm2 start ecosystem.config.js
   pm2 save
   ```

   **方式 B：前台临时验证（关窗即停）**
   ```bash
   ACCESS_TOKEN=换成你自己的强密码 PORT=3170 HOST=127.0.0.1 node index.js
   ```

4. 开机自启（首次部署执行一次）：`pm2 startup`，按它给出的命令复制执行，再 `pm2 save`。
5. 查看日志：`pm2 logs 51codetodo-sync`；重启：`pm2 restart 51codetodo-sync`。

> **令牌强度**：建议 16 位以上随机串，可用 `openssl rand -base64 24` 生成；客户端与服务端必须完全一致。**不设置 `ACCESS_TOKEN` 则任何人都能读写，公网绝对不要这样跑。** 令牌优先通过请求头 `x-access-token` 传递；`?token=` 查询参数会留在 Nginx/服务器访问日志里，仅用于联调，不要在公网日常使用。

## 三、本机验证
```bash
curl http://127.0.0.1:3170/health
# 带令牌：curl -H "x-access-token: 你的密码" http://127.0.0.1:3170/health
```
返回 `{"ok":true,"rev":0}` 即正常；设置了令牌时漏填/错填返回 `401`。

## 四、宝塔站点 + HTTPS（公网唯一推荐方式）
1. 准备一个解析到本机服务器的域名；宝塔「网站」→ 添加站点（纯静态即可，不用建 PHP/数据库）。
2. 站点设置 →「反向代理」→ 添加：
   - 代理名称：`51codetodo`
   - 目标 URL：`http://127.0.0.1:3170`
   - 发送域名：`$host`
3. 站点设置 →「SSL」→ Let's Encrypt 申请证书（宝塔通常自动续签），开启「强制 HTTPS」。
4. 安全组/宝塔防火墙只放行 80/443；3170 不对公网开放，配合 `HOST=127.0.0.1` 双保险。

参考的 Nginx 片段（宝塔界面配置等价，仅供理解）：
```nginx
location / {
    proxy_pass http://127.0.0.1:3170;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

## 五、客户端填写（设置页 → 团队同步）
| 设置项 | 填什么 |
| --- | --- |
| 服务器地址 | `https://你的域名`（不带路径；反代到 443 免写端口，非标准端口再补 `:端口`） |
| 访问令牌 | 与服务端 `ACCESS_TOKEN` 完全一致 |
| 昵称 | 自己的显示名（1–24 字），填好点「加入团队」拿到成员身份 |
| 同步开关 | 开启后每 30 秒自动推送/拉取，也可点「立即同步」手动触发 |

本机联调：服务端 `node index.js` 起在 127.0.0.1:3170，客户端地址填 `http://127.0.0.1:3170`（仅此一种 http 被允许）。

## 六、数据与备份
- 全部团队数据在 `data/board.json`（单文件、临时文件 + rename 原子写入，崩溃不写坏）。
- 备份：宝塔「计划任务」每天把 `board.json` 复制/打包到其他目录（或异地），按日期保留多份历史；复制瞬间服务端正在写也不会拷到半截文件（原子 rename）。
- 恢复：停掉 PM2（`pm2 stop 51codetodo-sync`），用备份覆盖 `data/board.json`，再 `pm2 start`。
- 注意：`board.json` 损坏时服务端会返回 500 并拒绝用空板覆盖，避免把现有数据静默冲掉；此时用备份恢复，不要直接删文件。

## 七、接口速查
所有接口在设置了 `ACCESS_TOKEN` 后都要鉴权（含 GET），带头 `x-access-token: 令牌`，或 URL 加 `?token=`（仅联调）。

| 方法 | 路径 | 请求体 | 返回 |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ok:true, rev}` |
| POST | `/join` | `{nickname}` | `{memberId, nickname, joinedAt}`（同昵称重复加入返回已有成员） |
| GET | `/members` | — | `{members:[...]}` 成员列表 |
| GET | `/board?since=N` | — | `{rev, members, tasks[]}`，N 为上次收到的 rev，增量拉取 |
| POST | `/push` | `{memberId, changes[]}` | `{rev, accepted, rejected}` |

`change` 两种形态：
- `{op:"upsert", task:{serverId, title, note, customerName, status, assignee, owner, dueAt, updatedAt, rev}}`
- `{op:"delete", serverId, updatedAt}`（删除写墓碑，不物理移除）

合并规则：按 `updatedAt` 比较，更旧的更新不覆盖；同刻以 `rev` 大者为准（最后写入胜出）。

状态码：`200` 成功；`400` 参数/JSON 非法；`401` 未授权；`404` 接口不存在；`413` 请求体超过 1MB；`500` 服务端错误（如数据文件损坏）。
