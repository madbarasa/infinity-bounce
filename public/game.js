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

const HIGHSCORE_KEY = 'multi_breakout_highscore';

let ws;
let wsGeneration = 0;
let reconnectTimer = null;
let reconnectAttempt = 0;

let playerId = null;
let myColor = null;

let gameState = {
    ball: null,
    bricks: [],
    players: [],
    lives: CONFIG.INITIAL_LIVES,
    status: 'waiting'
};

const keys = { left: false, right: false };
const mouse = { x: null };

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

function generatePlayerId() {
    return 'player_' + Math.random().toString(36).substr(2, 9);
}

function clearReconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function scheduleReconnect() {
    clearReconnect();
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 16000);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

/** 旧浏览器无 roundRect 时使用直角矩形 */
function fillRoundRect(context, x, y, w, h, r) {
    context.beginPath();
    if (typeof context.roundRect === 'function') {
        context.roundRect(x, y, w, h, r);
    } else {
        context.rect(x, y, w, h);
    }
    context.fill();
}

function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const socket = new WebSocket(`${protocol}//${host}`);
    const gen = ++wsGeneration;
    ws = socket;

    socket.onopen = () => {
        if (gen !== wsGeneration) return;
        clearReconnect();
        reconnectAttempt = 0;
        console.log('Connected to server');
        playerId = generatePlayerId();
        const colorIdx = Math.floor(Math.random() * CONFIG.MAX_PLAYERS);
        myColor = COLORS.players[colorIdx];

        socket.send(
            JSON.stringify({
                type: 'join',
                playerId: playerId,
                color: myColor
            })
        );
    };

    socket.onmessage = (event) => {
        if (gen !== wsGeneration) return;
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            console.warn('Invalid WebSocket message', e);
            return;
        }
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

    socket.onclose = () => {
        if (gen !== wsGeneration) return;
        console.log('Disconnected');
        showMenu('连接断开', '正在尝试自动重连…', '重连');
        scheduleReconnect();
    };
}

function sendInput() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
        JSON.stringify({
            type: 'input',
            playerId: playerId,
            left: keys.left,
            right: keys.right,
            mouseX: mouse.x
        })
    );
}

function updateUI() {
    const total = gameState.players.reduce((sum, p) => sum + (p.score || 0), 0);
    scoreEl.textContent = String(total);
    livesEl.textContent = gameState.lives;

    playersEl.innerHTML = gameState.players
        .map(
            (p) => `
        <div class="player-tag" style="background:${p.color}">
            ${p.id.substr(0, 8)} ${p.id === playerId ? '(你)' : ''}
        </div>
    `
        )
        .join('');

    const stored = localStorage.getItem(HIGHSCORE_KEY);
    const prevBest = stored === null || stored === '' ? 0 : Number(stored);
    highScoreEl.textContent = String(Number.isFinite(prevBest) ? prevBest : 0);
    if (total > prevBest) {
        highScoreEl.textContent = String(total);
        localStorage.setItem(HIGHSCORE_KEY, String(total));
    }

    pauseBtn.textContent = gameState.status === 'paused' ? '继续' : '暂停';

    if (gameState.status === 'waiting') {
        showMenu('多人打砖块', '等待玩家加入…', '开始游戏');
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

function draw() {
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const brick of gameState.bricks) {
        if (!brick.alive) continue;
        ctx.fillStyle = brick.color;
        fillRoundRect(ctx, brick.x, brick.y, brick.width, brick.height, 4);
    }

    for (const player of gameState.players) {
        ctx.fillStyle = player.color;
        fillRoundRect(ctx, player.x, player.y, CONFIG.PADDLE_WIDTH, CONFIG.PADDLE_HEIGHT, 8);

        ctx.fillStyle = '#fff';
        ctx.font = '10px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(
            player.id.substr(0, 4),
            player.x + CONFIG.PADDLE_WIDTH / 2,
            player.y - 5
        );
    }

    if (gameState.ball) {
        ctx.beginPath();
        ctx.arc(gameState.ball.x, gameState.ball.y, CONFIG.BALL_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.ball;
        ctx.fill();
    }

    if (gameState.status === 'paused') {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 48px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('已暂停', canvas.width / 2, canvas.height / 2);
    }
}

function showMenu(title, msg, btnText) {
    menuEl.classList.remove('hidden');
    document.getElementById('menu-title').textContent = title;
    document.getElementById('menu-message').textContent = msg;
    startBtn.textContent = btnText;
}

function hideMenu() {
    menuEl.classList.add('hidden');
}

function sendCommand(cmd) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'command', command: cmd }));
}

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
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        reconnectAttempt = 0;
        clearReconnect();
        connect();
        return;
    }
    if (gameState.status === 'paused') {
        sendCommand('pause');
    } else if (gameState.status === 'gameover' || gameState.status === 'win') {
        sendCommand('restart');
    } else {
        sendCommand('start');
    }
});

pauseBtn.addEventListener('click', () => {
    sendCommand('pause');
});

restartBtn.addEventListener('click', () => {
    sendCommand('restart');
});

window.addEventListener('load', () => {
    connect();

    function loop() {
        draw();
        requestAnimationFrame(loop);
    }
    loop();
});
