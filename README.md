# 51CodeTodo

一款面向个人与小团队的轻量待办工具：本地记录、智能整理、动态表情浮球提醒，并可通过自建云端服务端实现多人事项同步与看板协作。

## 功能特性

### 个人待办
- 新增、完成、归档、搜索待办事项，支持备注、到期时间、客户/项目归属。
- 状态清晰分为「待办 / 进行中 / 已完成」，支持列表标签页自定义。
- 每日自动备份，支持导出与恢复备份，本地数据保存在本机。

### 智能整理（自带 Key）
- 粘贴一段文字或一张截图，AI 自动整理成结构化待办草稿，核对后再保存。
- 🎤 **语音输入**：在新增待办弹窗点「语音」直接说话，连续识别、光标自动跟随，说完自动走 AI 整理填好时间/分类。
- 自带 Key（BYOK）模式，支持 MiniMax、DeepSeek、通义千问、智谱 GLM。
- 配置多个 Key 时自动故障切换：当前服务商失败或额度不足，自动切到下一个可用 Key。
- 图片直传失败时自动回退本机 OCR 文字识别，整理链路不中断。

### 动态表情浮球
- 桌面常驻小球，根据状态切换待机、满意、慌张、忙碌等表情，待办堆积时显示红点角标。
- 可在设置中开关、记忆位置。

### 团队云端同步（自建服务端）
- 客户端离线先改、联网自动推送/拉取，后台每 30 秒同步一次，也可手动「立即同步」。
- 团队看板可按「我 / 全部 / 指定成员」筛选，实时看到每个人的待办、进行中、已完成数量。
- 支持把事项指派给成员，最后写入胜出，删除以墓碑标记避免误覆盖。
- 服务端零依赖（仅 Node.js 内置模块），无需 npm install、无需数据库。

## 下载使用

普通用户直接在 [Releases 页面](https://github.com/zhaosenlin12-creator/51CodeTodo/releases/latest) 下载对应平台的安装包：

- **Windows**：下载 `51CodeTodo-x.y.z-setup.exe`，双击安装，本地任务与设置会被保留。
- **安卓**：下载 `51CodeTodo-android-arm64.apk`，传到手机安装（支持 arm64 真机）。
- **iOS**：需 Mac + Xcode 自行打包，暂未提供 IPA。

## 本地开发

### 环境要求
- Node.js 22+、pnpm（corepack 提供）
- Rust / Cargo、Windows C++ 构建工具（用于 Tauri 桌面端）

### 启动与测试
```powershell
cd app
corepack pnpm install --frozen-lockfile

# 开发模式
corepack pnpm tauri dev

# 前端单元测试
corepack pnpm test

# 核心 Rust 库测试
cargo test -p pometodo-core --locked

# 打包 NSIS 安装包
corepack pnpm tauri build --ci --bundles nsis
```

## 团队同步服务端部署

`server/` 目录为零依赖同步服务端，详细步骤见 [`server/README-deploy.md`](server/README-deploy.md)。简述：

1. 上传 `server/` 目录到服务器，用 PM2 常驻（默认端口 `3170`，约定使用 ≥3100 的端口避免冲突）。
2. 配置强访问令牌 `ACCESS_TOKEN`，公网务必设置。
3. 宝塔站点加 Nginx 反向代理到 `127.0.0.1:3170`，并申请 Let's Encrypt 证书、开启强制 HTTPS。
4. 客户端在「设置 → 团队同步」填入服务器地址、令牌与昵称，点「加入团队」。

## 目录结构

```
51CodeTodo/
├── app/                 # 桌面客户端（Tauri 2 + Rust + React 19 + Vite）
│   ├── src/             # 前端界面与契约
│   ├── crates/          # 核心 Rust 库（数据模型、存储、整理）
│   └── src-tauri/      # Tauri 主进程与系统集成
├── server/              # 零依赖 Node.js 团队同步服务端
└── README.md
```

## 许可

本项目依 **GPL-3.0-only** 许可发布，详见 `app/LICENSE`。
