// 多人协作打砖块 - 游戏客户端
// 支持 1-4 名玩家

const CONFIG = {
    CANVAS_WIDTH: 800,
    CANVAS_HEIGHT: 600,
    PADDLE_WIDTH: 80,
    PADDLE_HEIGHT: 12,
    PADDLE_SPEED: 7,
    BALL_RADIUS: 8,
    BALL_SPEED: 7,
    BRICK_ROWS: 5,
    BRICK_COLS: 10,
    BRICK_WIDTH: 70,
    BRICK_HEIGHT: 20,
    BRICK_PADDING: 5,
    BRICK_OFFSET_TOP: 60,
    INITIAL_LIVES: 3,
    POINTS_PER_BRICK: 10,
    MAX_PLAYERS: 4
};

const COLORS = {
    players: ['#4fc3f7', '#ab47bc', '#42a5f5', '#66bb6a'],
    ball: '#ffffff',
    bricks: ['#ef5350', '#ab47bc', '#42a5f5', '#26a69a', '#66bb6a']
};

// WebSocket 连接
let ws;
let playerId = null;
let myColor = null;

// 游戏状态（来自服务器）
let gameState = {
    ball: null,
    bricks: [],
    players: [],
    lives: CONFIG.INITIAL_LIVES,
    status: 'menu'
};

// 输入状态
const keys = { left: false, right: false };
const mouse = { x: null };

// DOM 元素
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const livesEl = document.getElementById('lives');
const highScoreEl = document.getElementById('high-score');
const playersEl = document.getElementById('players');
const menuEl = document.getElementById('game-menu');
const startBtn = document.getElementById('start-btn');
const pauseBtn = document.getElementById('pause-btn');
const restartBtn = document.getElementById('restart-btn');

// 生成随机玩家ID
function generatePlayerId() {
    return 'player_' + Math.random().toString(36).substr(2, 9);
}

// 连接 WebSocket
function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    ws = new WebSocket(`${protocol}//${host}`);

    ws.onopen = () => {
        console.log('Connected to server');
        playerId = generatePlayerId();
        // 随机选一个颜色
        const colorIdx = Math.floor(Math.random() * CONFIG.MAX_PLAYERS);
        myColor = COLORS.players[colorIdx];
        
        // 发送加入消息
        ws.send(JSON.stringify({
            type: 'join',
            playerId: playerId,
            color: myColor
        }));
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'gameState') {
            gameState = msg;
            updateUI();
            draw();
        } else if (msg.type === 'playerId') {
            playerId = msg.playerId;
        } else if (msg.type === 'error') {
            alert(msg.message);
        }
    };

    ws.onclose = () => {
        console.log('Disconnected');
        showMenu('连接断开', '正在尝试重连...', '重连');
    };
}

// 发送输入
function sendInput() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
        type: 'input',
        playerId: playerId,
        left: keys.left,
        right: keys.right,
        mouseX: mouse.x
    }));
}

// 计算挡板初始位置（根据玩家数量）
function getPaddlePositions(count) {
    const positions = [];
    if (count === 1) {
        positions.push((CONFIG.CANVAS_WIDTH - CONFIG.PADDLE_WIDTH) / 2);
    } else {
        const spacing = CONFIG.CANVAS_WIDTH / count;
        for (let i = 0; i < count; i++) {
            positions.push(spacing * i + (spacing - CONFIG.PADDLE_WIDTH) / 2);
        }
    }
    return positions;
}

// 更新UI
function updateUI() {
    scoreEl.textContent = gameState.players.reduce((sum, p) => sum + (p.score || 0), 0);
    livesEl.textContent = gameState.lives;
    
    // 玩家列表
    playersEl.innerHTML = gameState.players.map(p => `
        <div class="player-tag" style="background:${p.color}">
            ${p.id.substr(0, 8)} ${p.id === playerId ? '(你)' : ''}
        </div>
    `).join('');
    
    // 最高分
    const totalScore = scoreEl.textContent;
    highScoreEl.textContent = localStorage.getItem('multi_breakout_highscore') || 0;
    if (totalScore > highScoreEl.textContent) {
        highScoreEl.textContent = totalScore;
        localStorage.setItem('multi_breakout_highscore', totalScore);
    }
    
    // 按钮状态
    pauseBtn.textContent = gameState.status === 'paused' ? '继续' : '暂停';
    
    // 菜单
    if (gameState.status === 'menu') {
        showMenu('多人打砖块', '等待玩家加入...', '开始游戏');
    } else if (gameState.status === 'gameover') {
        showMenu('游戏结束', `最终得分: ${scoreEl.textContent}`, '再玩一次');
    } else if (gameState.status === 'win') {
        showMenu('恭喜通关！', `最终得分: ${scoreEl.textContent}`, '再玩一次');
    } else if (gameState.status === 'paused') {
        showMenu('已暂停', '点击继续游戏', '继续游戏');
    } else {
        hideMenu();
    }
}

// 绘制游戏
function draw() {
    // 清空
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // 绘制砖块
    for (const brick of gameState.bricks) {
        if (!brick.alive) continue;
        ctx.fillStyle = brick.color;
        ctx.beginPath();
        ctx.roundRect(brick.x, brick.y, brick.width, brick.height, 4);
        ctx.fill();
    }
    
    // 绘制玩家挡板
    for (const player of gameState.players) {
        ctx.fillStyle = player.color;
        ctx.beginPath();
        ctx.roundRect(player.x, player.y, CONFIG.PADDLE_WIDTH, CONFIG.PADDLE_HEIGHT, 8);
        ctx.fill();
        
        // 显示玩家ID
        ctx.fillStyle = '#fff';
        ctx.font = '10px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(player.id.substr(0, 4), player.x + CONFIG.PADDLE_WIDTH/2, player.y - 5);
    }
    
    // 绘制球
    if (gameState.ball) {
        ctx.beginPath();
        ctx.arc(gameState.ball.x, gameState.ball.y, CONFIG.BALL_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.ball;
        ctx.fill();
    }
    
    // 游戏状态覆盖
    if (gameState.status === 'paused') {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 48px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('已暂停', canvas.width/2, canvas.height/2);
    }
}

// 菜单控制
function showMenu(title, msg, btnText) {
    menuEl.classList.remove('hidden');
    document.getElementById('menu-title').textContent = title;
    document.getElementById('menu-message').textContent = msg;
    startBtn.textContent = btnText;
}

function hideMenu() {
    menuEl.classList.add('hidden');
}

// 发送命令
function sendCommand(cmd) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'command', command: cmd }));
}

// 事件绑定
document.addEventListener('keydown', (e) => {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.left = true;
    if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.right = true;
    if (e.code === 'Space') {
        e.preventDefault();
        sendCommand('pause');
    }
    sendInput();
});

document.addEventListener('keyup', (e) => {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.left = false;
    if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.right = false;
    sendInput();
});

canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    mouse.x = (e.clientX - rect.left) * scaleX;
    sendInput();
});

startBtn.addEventListener('click', () => {
    sendCommand('start');
});

pauseBtn.addEventListener('click', () => {
    sendCommand('pause');
});

restartBtn.addEventListener('click', () => {
    sendCommand('restart');
});

// 初始化
window.addEventListener('load', () => {
    connect();
    
    // 游戏循环（仅本地渲染，服务器驱动）
    function loop() {
        if (gameState.status === 'playing') {
            draw();
        }
        requestAnimationFrame(loop);
    }
    loop();
});