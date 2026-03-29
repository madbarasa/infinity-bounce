# Infinity Bounce / 多人打砖块

**仓库：** [github.com/madbarasa/infinity-bounce](https://github.com/madbarasa/infinity-bounce)

基于 **Node.js** 与 **WebSocket** 的浏览器多人协作打砖块游戏：多名玩家各自控制挡板，共用一颗球与一面砖墙，游戏逻辑在服务端权威模拟，客户端负责渲染与输入同步。

| 项目信息 |  |
| --- | --- |
| 包名 | `multi-breakout` |
| 版本 | 1.1.1 |
| 运行时 | Node.js |

---

## 功能概览

- **1～4 人**同房间协作，挡板随人数自动均匀排布  
- **服务器权威**：球体运动、碰撞、得分与生命由服务端 `gameLoop`（约 60Hz）计算  
- **实时同步**：通过 WebSocket 广播完整游戏状态  
- **断线重连**：客户端支持指数退避自动重连与手动重连  

更完整的规则与版本说明见仓库内 [`docs/策划文档.md`](docs/策划文档.md)。

---

## 技术栈

- **服务端**：Node.js（`http` 静态资源 + [`ws`](https://github.com/websockets/ws)）  
- **客户端**：原生 HTML / CSS / Canvas（`public/`）  

---

## 环境要求

- [Node.js](https://nodejs.org/)（建议当前 LTS）  
- 现代浏览器（支持 Canvas 与 WebSocket）  

---

## 快速开始

```bash
git clone https://github.com/madbarasa/infinity-bounce.git
cd infinity-bounce
npm install
npm start
```

默认在 **http://localhost:8082** 提供页面与 WebSocket。  

- 本机游玩：浏览器打开上述地址即可。  
- 局域网多人：其他设备使用 `http://<本机局域网IP>:8082` 访问（需防火墙放行该端口）。  

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

仓库包含 [`render.yaml`](render.yaml)，可在 [Render](https://render.com/) 等平台以 Web 服务部署：`buildCommand` 为 `npm install`，`startCommand` 为 `npm start`。部署后请将游戏页面与 WebSocket 指向该平台提供的 **HTTPS/WSS** 地址（若平台要求环境变量指定端口，请按其文档设置，使 `server.js` 监听对应端口）。

---

## 目录结构（简要）

```
.
├── server.js          # HTTP + WebSocket 服务与游戏逻辑
├── package.json
├── render.yaml        # 示例部署配置
├── public/
│   ├── index.html
│   ├── style.css
│   └── game.js        # 客户端渲染与网络
└── docs/
    └── 策划文档.md    # 规则与版本记录
```

---

## 许可证

以 `package.json` 中的 **ISC** 为准（若仓库另有 `LICENSE` 文件，以该文件为准）。

---

## 致谢

使用 [ws](https://www.npmjs.com/package/ws) 作为 WebSocket 实现。
