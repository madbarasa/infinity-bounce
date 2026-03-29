# 多人协作打砖块 - 开发计划

## 目标
支持 1-4 名玩家在线协作打砖块

## 架构
- **前端**: Canvas 渲染，每个玩家有自己的挡板（颜色不同）
- **后端**: WebSocket 服务器（Node.js + ws）
- **协议**: JSON 消息（玩家加入/离开、输入、游戏状态同步）

## 游戏规则
- 所有玩家共享一个球和砖块
- 每个玩家有自己的挡板，位于底部不同位置
- 玩家数量 1-4 人
- 生命值共享（初始3条）
- 分数共享
- 任意玩家触球，球反弹方向受挡板位置影响

## 消息类型
```js
// 客户端 -> 服务器
{ type: 'join', playerId: 'xxx', color: '#ff0000' }
{ type: 'input', playerId: 'xxx', left: bool, right: bool }

// 服务器 -> 客户端
{ type: 'gameState', 
  ball: {x, y, dx, dy},
  bricks: [...],
  players: [{id, x, color, score}],
  lives: 3,
  status: 'playing' | 'paused' | 'gameover' | 'win'
}
```

## 技术栈
- Node.js + ws (WebSocket)
- 前端保持原 HTML5 Canvas
- 房间管理（简单数组）

## 文件结构
```
multi-breakout/
├── server.js       # WebSocket 服务器
├── public/
│   ├── index.html
│   ├── style.css
│   ├── game.js     # 多人版游戏逻辑
│   └── assets/     # 资源
└── README.md
```

## 开发步骤
1. 创建 WebSocket 服务器基础
2. 实现房间和玩家管理
3. 实现游戏状态同步机制
4. 更新前端支持多玩家渲染
5. 修改碰撞检测（球与多个挡板）
6. 测试 1-4 人联机

## 预计时间
2-3 小时完成基础版本