# Infinity Bounce / 多人打砖块

![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)
![License](https://img.shields.io/badge/license-ISC-green.svg)
![Node.js](https://img.shields.io/badge/node->=18.0.0-brightgreen.svg)

**在线试玩：** [https://infinity-bounce.onrender.com](https://infinity-bounce.onrender.com)

基于 **Node.js** 与 **WebSocket** 的浏览器多人协作打砖块游戏：多名玩家各自控制挡板，共用球与一面砖墙，游戏逻辑在服务端权威模拟，客户端负责渲染与输入同步。

| 项目信息 |  |
| --- | --- |
| 包名 | `multi-breakout` |
| 版本 | 2.0.0 |
| 运行时 | Node.js |

---

## 功能概览

- **1～4 人**同房间协作，挡板随人数自动均匀排布
- **服务器权威 + 身份绑定连接**：球体运动、碰撞、得分与生命由服务端 `game-core.js` 计算，`playerId` 由服务端生成并绑定到 WebSocket 连接
- **入参校验**：`join` / `input` / `command` / `ping` 全部做类型与范围校验，含 NaN 防御、消息限流、`maxPayload` 与 Origin 校验
- **实时同步**：模拟约 125Hz、状态广播约 30Hz，通过 WebSocket 下发 `gameState`
- **全量对账**：`fullState` 下发完整砖块状态与玩家列表，玩家增删与砖墙重建时保持一致
- **断线清理与心跳**：服务端心跳检测、断线移出房间并重排挡板；客户端指数退避自动重连与重连清理
- **Web Audio 音效与震动反馈**：击砖、得分、道具等事件附带音效，支持设备震动
- **设置面板与开发者名单**：设置、帮助、开发者名单面板，含音效与震动开关
- **道具与奖励**：W 加宽挡板、P 加分、M 多球；每 100 分奖励 1 条命

更完整的规则与版本说明见仓库内 [`docs/策划文档.md`](docs/策划文档.md)。

---

## 技术栈

- **服务端**：Node.js（`http` 静态资源 + [`ws`](https://github.com/websockets/ws) 8.23.0），纯逻辑层 `game-core.js`
- **客户端**：原生 HTML / CSS / Canvas（`public/`）
- **测试与校验**：Node.js 内置 `node:test` 测试套件与 `tools/validate.mjs` 静态校验

---

## 环境要求

- [Node.js](https://nodejs.org/) >=18（建议当前 LTS）
- 现代浏览器（支持 Canvas 与 WebSocket）

---

## 快速开始

```bash
git clone https://github.com/madbarasa/infinity-bounce.git
cd infinity-bounce
npm ci
npm start
```

默认在 **http://localhost:8082** 提供页面与 WebSocket。

- 本机游玩：浏览器打开上述地址即可。
- 局域网多人：其他设备使用 `http://<本机局域网IP>:8082` 访问（需防火墙放行该端口）。
- `npm test`：运行 `node:test` 测试套件，覆盖 `game-core.js` 纯逻辑与服务端协议。
- `npm run validate`：运行 `tools/validate.mjs`，校验版本号一致性、JSON 合法性、资源与引用完整性。

---

## 操作说明

| 操作 | 说明 |
| --- | --- |
| 移动挡板 | ← → 或 **A** / **D**；也可在画布区域用鼠标移动 |
| 暂停 | **空格** |
| 开始 | 至少一名玩家在房间内，点击「开始游戏」 |
| 再玩一局 | 游戏结束或通关后点击「再玩一次」 |

邀请朋友打开**同一页面地址**即可加入同一房间。

---

## 部署（示例：Render）

仓库包含 [`render.yaml`](render.yaml)，可在 [Render](https://render.com/) 等平台以 Web 服务部署：`buildCommand` 为 `npm ci`（按 `package-lock.json` 精确安装），`startCommand` 为 `npm start`，`healthCheckPath` 为 `/health`（服务端返回 `status`、`version`、玩家数与运行时长）。通过 **PORT** 环境变量指定监听端口（1–65535 整数，默认 8082），服务端会对 PORT 做数值校验。部署后请将游戏页面与 WebSocket 指向该平台提供的 **HTTPS/WSS** 地址。

---

## 目录结构（简要）

```
.
├── server.js                  # HTTP + WebSocket 服务、连接治理与 /health
├── game-core.js               # 纯逻辑层：CONFIG、规则、状态序列化
├── package.json
├── package-lock.json
├── render.yaml                # 示例部署配置（npm ci / /health）
├── .gitignore
├── public/
│   ├── index.html             # 页面、面板与图标引用
│   ├── style.css              # 样式（CSS 变量与 clamp()）
│   └── game.js                # 客户端渲染、网络、音效与面板
├── assets/
│   ├── bg.webp                # 主界面背景图（约 15KB）
│   └── icons/                 # 设置/帮助/返回/关闭/音效/震动/开发者名单等图标
├── docs/
│   └── 策划文档.md            # 规则与版本记录
├── test/                      # node:test 测试套件
└── tools/
    ├── gen-assets.py          # 生成背景图与图标资产
    ├── validate.mjs           # 版本号一致性与资源校验脚本
    └── add-node-to-user-path.ps1
```

---

## 许可证

以 `package.json` 中的 **ISC** 为准（若仓库另有 `LICENSE` 文件，以该文件为准）。

---

## 致谢

使用 [ws](https://www.npmjs.com/package/ws) 作为 WebSocket 实现。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
