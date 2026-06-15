const http = require('http');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto'); // 引入原生加密模块
const { ExpressPeerServer } = require('peer');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io'); 
const xss = require('xss');             

// ==========================================
// 环境变量与全局安全配置
// ==========================================
const PORT = process.env.PORT || 8080;
const AUTH_KEY = process.env.AUTH_KEY || 'YOUR_SECRET_KEY'; 

const ROOM_EMPTY_TIMEOUT_MS = 5 * 60 * 1000; 
const ROOM_HARD_EXPIRATION_MS = 24 * 60 * 60 * 1000; 
const MAX_GLOBAL_ROOMS = 2666;
const MAX_PAYLOAD_SIZE = 1e5; 

const rooms = {};

// ==========================================
// 安全工具：密码哈希化 (防止明文密码在内存中泄漏)
// ==========================================
function hashPassword(password) {
    if (!password) return '';
    return crypto.createHash('sha256').update(String(password)).digest('hex');
}

// ==========================================
// 防恶意攻击：IP 频率限制中间件 
// ==========================================
const ipCreationCounts = new Map();
function rateLimitMiddleware(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const now = Date.now();
    
    let userRecords = ipCreationCounts.get(ip) || [];
    userRecords = userRecords.filter(timestamp => now - timestamp < 60 * 60 * 1000);
    
    if (userRecords.length >= 30) {
        return res.status(429).json({ error: '创建房间过于频繁，请稍后再试' });
    }
    
    userRecords.push(now);
    ipCreationCounts.set(ip, userRecords);
    next();
}
setInterval(() => ipCreationCounts.clear(), 2 * 60 * 60 * 1000);

function generateShortCode() {
    return (Math.floor(Math.random() * 900000) + 100000).toString();
}

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = [
    "https://player.arksec.net",
    "https://game.arksec.net"
];

app.use(cors({ origin: allowedOrigins, methods: ["GET", "POST"] }));
app.use(express.json({ limit: '50kb' })); 

// ==========================================
// 1. 基础 HTTP 路由 (带房间级密码门禁)
// ==========================================
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<h1>Nexus Backend is running Securely with Hash Auth</h1>');
});

const serverStartTime = process.hrtime.bigint();
app.get('/get-time', (req, res) => {
    const uptimeNanoseconds = process.hrtime.bigint() - serverStartTime;
    res.json({ serverTime: Number(uptimeNanoseconds) / 1e6 });
});

// 🚀 创建房间：保存密码哈希
app.post('/register-room', rateLimitMiddleware, (req, res) => {
    if (Object.keys(rooms).length >= MAX_GLOBAL_ROOMS) {
        return res.status(503).json({ error: '服务器房间容量已满，请稍后再试' });
    }

    const { longId, roomPassword } = req.body;
    if (!longId || !roomPassword) return res.status(400).json({ error: '缺少长ID或房间密码' });
    
    let shortCode;
    do { shortCode = generateShortCode(); } while (rooms[shortCode]);

    rooms[shortCode] = { 
        host: longId, 
        pwdHash: hashPassword(roomPassword), // 仅保存哈希值
        createdAt: Date.now(),
        emptySince: null 
    };
    console.log(`[API] 房间已创建: ${shortCode}`);
    res.status(201).json({ shortCode });
});

// 🚀 访客加入：校验密码哈希
app.post('/register-player2', (req, res) => {
    const { shortCode, p2_longId, roomPassword } = req.body;
    if (!shortCode || !p2_longId || !roomPassword) return res.status(400).json({ error: '缺少参数' });

    const room = rooms[shortCode];
    if (!room) return res.status(404).json({ error: '未找到房间或房间已被解散' });

    // 门禁拦截
    if (room.pwdHash !== hashPassword(roomPassword)) {
        console.warn(`[Auth] 房间 ${shortCode} 密码尝试失败`);
        return res.status(401).json({ error: '房间密码错误' });
    }

    const activeSocketsCount = io.sockets.adapter.rooms.get(shortCode)?.size || 0;
    if (activeSocketsCount >= 2) {
        return res.status(409).json({ error: '当前房间已满员 (Max: 2)' }); 
    }

    room.emptySince = null; 
    console.log(`[Room] 访客密码验证通过，允许加入房间 ${shortCode}`);
    res.status(200).send();
});

// 🚀 获取房主 ID：同样需要密码校验
app.get('/get-room/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    const { pwd } = req.query; // 从 URL 参数获取前端传来的密码
    
    const room = rooms[shortCode];
    if (!room) return res.status(404).json({ error: '未找到该房间' });
    
    if (room.pwdHash !== hashPassword(pwd)) {
        return res.status(401).json({ error: '密码错误，拒绝获取房主信令' });
    }

    res.json({ longId: room.host });
});

const server = http.createServer(app);

// ==========================================
// 2. Socket.io 实时服务 (带门禁与防旁听)
// ==========================================
const io = new Server(server, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: MAX_PAYLOAD_SIZE 
});

io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.headers['authorization'];
    if (token === `Bearer ${AUTH_KEY}` || token === AUTH_KEY) return next();
    return next(new Error('Unauthorized: Invalid Server Key'));
});

io.on('connection', (socket) => {
    
    // 🚀 Socket 房间物理门禁
    socket.on('join_room', (data) => {
        if (!data || typeof data !== 'object') return;
        const { shortCode, roomPassword } = data;
        
        const room = rooms[shortCode];
        if (!room) return;

        // 密码哈希校验
        if (room.pwdHash !== hashPassword(roomPassword)) {
            console.warn(`[Socket] 拒绝未授权的加入请求: ${socket.id}`);
            return; // 密码不对，直接拒绝让其加入 Socket 房间
        }

        socket.join(shortCode);
        room.emptySince = null; 
        console.log(`[Socket] ${socket.id} 物理门禁验证通过，已加入: ${shortCode}`);
    });

    socket.on('chat_message', (data) => {
        const { shortCode, message, senderId } = data;
        // 🚀 核心安全：发消息前，检查该 Socket 是否真的通过了门禁并在房间内
        if (!shortCode || !message || !socket.rooms.has(shortCode)) return;
        
        const safeMessage = xss(message.trim());
        if (safeMessage) {
            io.to(shortCode).emit('chat_message', {
                senderId: xss(senderId),
                message: safeMessage,
                timestamp: Date.now()
            });
        }
    });

    socket.on('media_sync', (data) => {
        const { shortCode, type, action, currentTime, mediaUrl, authPayload, playing } = data;
        // 🚀 防非法广播：未加入房间的黑客无法向房间发送控制指令
        if (!shortCode || !socket.rooms.has(shortCode)) return;
        
        socket.to(shortCode).emit('media_sync', {
            type, action, currentTime, playing,
            mediaUrl: mediaUrl ? xss(mediaUrl) : null,
            authPayload: authPayload || null,
            timestamp: Date.now()
        });
    });

    socket.on('game_sync', (data) => {
        const { shortCode, ...payload } = data;
        if (!shortCode || !socket.rooms.has(shortCode)) return;
        
        socket.to(shortCode).emit('game_sync', {
            ...payload,
            timestamp: Date.now()
        });
    });
});

// ==========================================
// 3. PeerJS 信令服务
// ==========================================
const peerServer = ExpressPeerServer(server, {
    debug: false, 
    proxied: true, 
    generateClientId: () => uuidv4(),
    path: '/peerjs'
});

app.use('/peerjs', peerServer);

// ==========================================
// 精准房间生命周期管家
// ==========================================
setInterval(() => {
    const now = Date.now();
    for (const shortCode in rooms) {
        const room = rooms[shortCode];
        const activeSockets = io.sockets.adapter.rooms.get(shortCode)?.size || 0;
        
        if (activeSockets === 0) {
            if (!room.emptySince) {
                room.emptySince = now; 
            } else if (now - room.emptySince > ROOM_EMPTY_TIMEOUT_MS) {
                delete rooms[shortCode];
                console.log(`[GC] 💥 房间 ${shortCode} 空闲超过5分钟，已彻底强制销毁`);
            }
        } else {
            room.emptySince = null; 
        }

        if (now - room.createdAt > ROOM_HARD_EXPIRATION_MS) {
            delete rooms[shortCode];
        }
    }
}, 15 * 1000); 

server.listen(PORT, '0.0.0.0', () => { 
    console.log(`[Server] 监听端口: ${PORT} | 强哈希房间加密已启用`);
});
