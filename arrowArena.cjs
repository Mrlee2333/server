'use strict';

const crypto = require('crypto');

const WORLD_W = 2600;
const WORLD_H = 1800;
const TICK_MS = 50;
const SNAPSHOT_MS = 1000 / 15;
const OFFLINE_GRACE_MS = 3 * 60 * 1000;
const EMPTY_ROOM_TTL_MS = 10_000;

const WEAPONS = Object.freeze({
    sword: { damage: 44, cooldown: 480, range: 112, speed: 0, life: 0, pierce: 0 },
    bow: { damage: 27, cooldown: 620, range: 780, speed: 720, life: 1200, pierce: 0 },
    pistol: { damage: 14, cooldown: 230, range: 850, speed: 1050, life: 850, pierce: 0 },
    pulse: { damage: 36, cooldown: 510, range: 760, speed: 690, life: 1200, pierce: 2, energy: 8 }
});

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function finiteNumber(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
}

function cleanName(value) {
    return String(value || '像素勇士').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 12) || '像素勇士';
}

function cleanRoomCode(value) {
    const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    return code.length === 6 ? code : '';
}

function cleanBrowserId(value) {
    const id = String(value || '').trim();
    return /^[A-Za-z0-9_-]{16,80}$/.test(id) ? id : '';
}

function requestIp(req) {
    const forwarded = req.headers?.['x-forwarded-for'];
    return String(Array.isArray(forwarded) ? forwarded[0] : forwarded || req.ip || req.socket?.remoteAddress || '').split(',')[0].trim();
}

function socketIp(socket) {
    const forwarded = socket.handshake.headers?.['x-forwarded-for'];
    return String(Array.isArray(forwarded) ? forwarded[0] : forwarded || socket.handshake.address || '').split(',')[0].trim();
}

function fingerprint(value, secret) {
    return crypto.createHmac('sha256', secret).update(String(value)).digest('base64url').slice(0, 22);
}

function randomCode(rooms) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 30; attempt++) {
        let code = '';
        for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
        if (!rooms.has(code)) return code;
    }
    return '';
}

function signTicket(payload, secret) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${signature}`;
}

function verifyTicket(token, secret) {
    if (typeof token !== 'string' || token.length > 1024) return null;
    const [body, signature] = token.split('.');
    if (!body || !signature) return null;
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    let received;
    try { received = Buffer.from(signature, 'base64url'); } catch { return null; }
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!payload.id || !payload.exp || payload.exp < Date.now()) return null;
        return payload;
    } catch { return null; }
}

function createRoom(code) {
    return {
        code,
        players: new Map(),
        projectiles: [],
        nextProjectileId: 1,
        createdAt: Date.now(),
        emptyAt: 0,
        snapshotAt: 0
    };
}

function createPlayer(identity, socket, room) {
    const slot = room.players.size;
    const angle = slot / 6 * Math.PI * 2;
    return {
        id: identity.id,
        socketId: socket.id,
        name: identity.name,
        x: WORLD_W / 2 + Math.cos(angle) * 260,
        y: WORLD_H / 2 + Math.sin(angle) * 220,
        vx: 0, vy: 0, aimX: 1, aimY: 0,
        dashX: 1, dashY: 0,
        hp: 125, maxHp: 125, energy: 100,
        weapon: 'bow', state: 'idle', alive: true,
        kills: 0, deaths: 0,
        lastInputSeq: 0, lastShot: 0, lastDash: 0,
        dashUntil: 0, invulnerableUntil: Date.now() + 1000, respawnAt: 0,
        offlineAt: 0,
        inputWindowAt: Date.now(), inputCount: 0, strikes: 0,
        input: { moveX: 0, moveY: 0, aimX: 1, aimY: 0, shooting: false, dash: false }
    };
}

function getProjectile(room) {
    for (const projectile of room.projectiles) if (!projectile.active) return projectile;
    if (room.projectiles.length >= 96) return null;
    const projectile = { active: false, id: 0, ownerId: '', x: 0, y: 0, vx: 0, vy: 0, damage: 0, expiresAt: 0, weapon: 'bow', pierce: 0 };
    room.projectiles.push(projectile);
    return projectile;
}

function damagePlayer(room, target, owner, damage, now) {
    if (!target.alive || now < target.invulnerableUntil) return;
    target.hp = Math.max(0, target.hp - damage);
    target.invulnerableUntil = now + 300;
    if (target.hp > 0) return;
    target.alive = false;
    target.state = 'dead';
    target.vx = target.vy = 0;
    target.deaths++;
    target.respawnAt = now + 3000;
    if (owner && owner !== target) owner.kills++;
}

function useWeapon(room, player, now) {
    const weapon = WEAPONS[player.weapon] || WEAPONS.bow;
    if (now - player.lastShot < weapon.cooldown) return;
    if (weapon.energy && player.energy < weapon.energy) return;
    player.lastShot = now;
    player.state = 'attack';
    if (weapon.energy) player.energy -= weapon.energy;

    if (player.weapon === 'sword') {
        const rangeSq = weapon.range * weapon.range;
        for (const target of room.players.values()) {
            if (target === player || !target.alive) continue;
            const dx = target.x - player.x;
            const dy = target.y - player.y;
            const distanceSq = dx * dx + dy * dy;
            if (distanceSq > 1 && distanceSq <= rangeSq && (dx * player.aimX + dy * player.aimY) / Math.sqrt(distanceSq) > 0.15) {
                damagePlayer(room, target, player, weapon.damage, now);
            }
        }
        return;
    }

    const projectile = getProjectile(room);
    if (!projectile) return;
    projectile.active = true;
    projectile.id = room.nextProjectileId++;
    projectile.ownerId = player.id;
    projectile.x = player.x + player.aimX * 30;
    projectile.y = player.y + player.aimY * 30;
    projectile.vx = player.aimX * weapon.speed;
    projectile.vy = player.aimY * weapon.speed;
    projectile.damage = weapon.damage;
    projectile.expiresAt = now + weapon.life;
    projectile.weapon = player.weapon;
    projectile.pierce = weapon.pierce;
}

function respawnPlayer(player, now) {
    const seed = crypto.randomInt(0, 8);
    const angle = seed / 8 * Math.PI * 2;
    player.x = WORLD_W / 2 + Math.cos(angle) * 420;
    player.y = WORLD_H / 2 + Math.sin(angle) * 320;
    player.vx = player.vy = 0;
    player.hp = player.maxHp;
    player.energy = 100;
    player.alive = true;
    player.state = 'idle';
    player.respawnAt = 0;
    player.invulnerableUntil = now + 1200;
}

function simulateRoom(room, now, dt) {
    for (const player of room.players.values()) {
        if (player.offlineAt) continue;
        if (!player.alive) {
            if (player.respawnAt && now >= player.respawnAt) respawnPlayer(player, now);
            continue;
        }

        const input = player.input;
        if (input.dash) {
            input.dash = false;
            if (now - player.lastDash >= 1000 && player.energy >= 25) {
                player.lastDash = now;
                player.dashUntil = now + 190;
                player.energy -= 25;
                const hasMove = Math.abs(input.moveX) + Math.abs(input.moveY) > 0.05;
                player.dashX = hasMove ? input.moveX : player.aimX;
                player.dashY = hasMove ? input.moveY : player.aimY;
            }
        }

        if (now < player.dashUntil) {
            player.vx = player.dashX * 760;
            player.vy = player.dashY * 760;
            player.state = 'move';
        } else {
            player.vx = input.moveX * 235;
            player.vy = input.moveY * 235;
            player.state = Math.abs(input.moveX) + Math.abs(input.moveY) > 0.02 ? 'move' : 'idle';
        }

        player.x = clamp(player.x + player.vx * dt, 35, WORLD_W - 35);
        player.y = clamp(player.y + player.vy * dt, 35, WORLD_H - 35);
        player.energy = Math.min(100, player.energy + 2.5 * dt);
        if (input.shooting) useWeapon(room, player, now);
    }

    for (const projectile of room.projectiles) {
        if (!projectile.active) continue;
        if (now >= projectile.expiresAt) { projectile.active = false; continue; }
        projectile.x += projectile.vx * dt;
        projectile.y += projectile.vy * dt;
        if (projectile.x < 0 || projectile.y < 0 || projectile.x > WORLD_W || projectile.y > WORLD_H) { projectile.active = false; continue; }
        const owner = room.players.get(projectile.ownerId);
        for (const target of room.players.values()) {
            if (!target.alive || target.id === projectile.ownerId) continue;
            const dx = target.x - projectile.x;
            const dy = target.y - projectile.y;
            if (dx * dx + dy * dy > 28 * 28) continue;
            damagePlayer(room, target, owner, projectile.damage, now);
            if (projectile.pierce-- <= 0) projectile.active = false;
            break;
        }
    }
}

function makeSnapshot(room, now) {
    const players = [];
    const projectiles = [];
    for (const player of room.players.values()) {
        if (player.offlineAt) continue;
        players.push([player.id, player.name, Math.round(player.x), Math.round(player.y), Math.round(player.vx), Math.round(player.vy), +player.aimX.toFixed(3), +player.aimY.toFixed(3), Math.round(player.hp), player.maxHp, Math.round(player.energy), player.weapon, player.state, player.kills, player.deaths, player.lastInputSeq]);
    }
    for (const projectile of room.projectiles) {
        if (projectile.active) projectiles.push([projectile.id, Math.round(projectile.x), Math.round(projectile.y), Math.round(projectile.vx), Math.round(projectile.vy), projectile.weapon, projectile.ownerId]);
    }
    return { t: now, r: room.code, p: players, b: projectiles };
}

function attachArrowArena({ app, io, authKey }) {
    const secret = process.env.ARROW_ARENA_SECRET || authKey;
    const maxRooms = clamp(Number(process.env.ARROW_ARENA_MAX_ROOMS) || 8, 1, 8);
    const maxPlayers = clamp(Number(process.env.ARROW_ARENA_MAX_PLAYERS) || 20, 2, 20);
    const maxPlayersPerIp = clamp(Number(process.env.ARROW_ARENA_MAX_PLAYERS_PER_IP) || 4, 1, 20);
    const rooms = new Map();
    const sessionRates = new Map();
    const activeIdentities = new Map();
    const activeBrowsers = new Map();
    const activeIpCounts = new Map();
    const browserIdentities = new Map();
    const arena = io.of('/arrow-arena');

    app.get('/arrow-arena/health', (_req, res) => res.json({
        ok: true,
        rooms: rooms.size,
        players: Array.from(rooms.values()).reduce((sum, room) => sum + room.players.size, 0),
        onlinePlayers: Array.from(rooms.values()).reduce((sum, room) => sum + Array.from(room.players.values()).filter(player => !player.offlineAt).length, 0),
        tickRate: 1000 / TICK_MS,
        snapshotRate: 15,
        maxRooms,
        maxPlayersPerRoom: maxPlayers,
        offlineGraceSeconds: OFFLINE_GRACE_MS / 1000,
        memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
    }));

    app.post('/arrow-arena/session', (req, res) => {
        const ip = requestIp(req);
        const now = Date.now();
        const rate = sessionRates.get(ip) || { at: now, count: 0 };
        if (now - rate.at > 60_000) { rate.at = now; rate.count = 0; }
        if (++rate.count > 60) { sessionRates.set(ip, rate); return res.status(429).json({ error: '请求过于频繁' }); }
        sessionRates.set(ip, rate);
        const browserId = cleanBrowserId(req.body?.browserId);
        if (!browserId) return res.status(400).json({ error: '浏览器身份无效' });
        const ipKey = fingerprint(ip, secret);
        const browserKey = fingerprint(`${ipKey}:${browserId}`, secret);
        let cached = browserIdentities.get(browserKey);
        if (!cached || now - cached.lastSeen > 30 * 60_000) cached = { playerId: crypto.randomUUID(), lastSeen: now };
        cached.lastSeen = now;
        browserIdentities.set(browserKey, cached);
        const identity = { id: cached.playerId, name: cleanName(req.body?.name), ipKey, browserKey, exp: now + 30 * 60_000 };
        res.json({ token: signTicket(identity, secret), playerId: identity.id, name: identity.name, namespace: '/arrow-arena' });
    });

    arena.use((socket, next) => {
        const identity = verifyTicket(socket.handshake.auth?.ticket, secret);
        if (!identity) return next(new Error('Invalid or expired game ticket'));
        if (identity.ipKey !== fingerprint(socketIp(socket), secret)) return next(new Error('Game ticket IP mismatch'));
        const replacing = activeBrowsers.has(identity.browserKey);
        if (!replacing && (activeIpCounts.get(identity.ipKey) || 0) >= maxPlayersPerIp) return next(new Error('Too many active game clients from this IP'));
        socket.data.arenaIdentity = identity;
        socket.data.replacingBrowser = replacing;
        next();
    });

    function leaveCurrentRoom(socket) {
        const code = socket.data.arenaRoom;
        if (!code) return;
        const room = rooms.get(code);
        if (room) {
            room.players.delete(socket.data.arenaIdentity.id);
            if (room.players.size === 0) room.emptyAt = Date.now();
        }
        socket.leave(code);
        socket.data.arenaRoom = '';
    }

    function markPlayerOffline(socket) {
        const code = socket.data.arenaRoom;
        if (!code) return;
        const room = rooms.get(code);
        const player = room?.players.get(socket.data.arenaIdentity.id);
        if (player && player.socketId === socket.id) {
            player.socketId = '';
            player.offlineAt = Date.now();
            player.vx = player.vy = 0;
            player.input.moveX = player.input.moveY = 0;
            player.input.shooting = player.input.dash = false;
            player.state = 'offline';
        }
        socket.leave(code);
        socket.data.arenaRoom = '';
    }

    arena.on('connection', (socket) => {
        const identityId = socket.data.arenaIdentity.id;
        const browserKey = socket.data.arenaIdentity.browserKey;
        const ipKey = socket.data.arenaIdentity.ipKey;
        const previousBrowserSocketId = activeBrowsers.get(browserKey);
        const replacingBrowser = previousBrowserSocketId && previousBrowserSocketId !== socket.id;
        if (!replacingBrowser) {
            activeIpCounts.set(ipKey, (activeIpCounts.get(ipKey) || 0) + 1);
        }
        activeBrowsers.set(browserKey, socket.id);
        const previousSocket = activeIdentities.get(identityId);
        activeIdentities.set(identityId, socket.id);
        const staleSocketIds = new Set([previousBrowserSocketId, previousSocket]);
        staleSocketIds.delete(undefined);
        staleSocketIds.delete(socket.id);
        for (const staleSocketId of staleSocketIds) {
            const oldSocket = arena.sockets.get(staleSocketId);
            if (oldSocket) oldSocket.disconnect(true);
        }
        socket.on('arena_join', (data = {}, acknowledge = () => {}) => {
            leaveCurrentRoom(socket);
            for (const existingRoom of rooms.values()) {
                const existingPlayer = existingRoom.players.get(socket.data.arenaIdentity.id);
                if (!existingPlayer) continue;
                existingPlayer.socketId = socket.id;
                existingPlayer.offlineAt = 0;
                existingPlayer.name = socket.data.arenaIdentity.name;
                existingPlayer.state = existingPlayer.alive ? 'idle' : 'dead';
                existingRoom.emptyAt = 0;
                socket.data.arenaRoom = existingRoom.code;
                socket.join(existingRoom.code);
                return acknowledge({ ok: true, roomCode: existingRoom.code, playerId: existingPlayer.id, maxPlayers, reconnected: true });
            }
            let code = cleanRoomCode(data.roomCode);
            let room = code ? rooms.get(code) : null;
            if (!room && !code) {
                for (const candidate of rooms.values()) {
                    if (candidate.players.size < maxPlayers) { room = candidate; break; }
                }
            }
            if (!room) {
                if (rooms.size >= maxRooms) return acknowledge({ ok: false, error: '联机房间已满' });
                code = code || randomCode(rooms);
                if (!code) return acknowledge({ ok: false, error: '无法创建房间' });
                room = createRoom(code);
                rooms.set(code, room);
            }
            if (room.players.size >= maxPlayers) return acknowledge({ ok: false, error: '房间人数已满' });
            const player = createPlayer(socket.data.arenaIdentity, socket, room);
            room.players.set(player.id, player);
            room.emptyAt = 0;
            socket.data.arenaRoom = room.code;
            socket.join(room.code);
            acknowledge({ ok: true, roomCode: room.code, playerId: player.id, maxPlayers });
        });

        socket.on('arena_input', (data) => {
            const room = rooms.get(socket.data.arenaRoom);
            const player = room?.players.get(socket.data.arenaIdentity.id);
            if (!player || !data || typeof data !== 'object') return;
            const now = Date.now();
            if (now - player.inputWindowAt >= 1000) { player.inputWindowAt = now; player.inputCount = 0; }
            if (++player.inputCount > 40) {
                if (++player.strikes >= 3) socket.disconnect(true);
                return;
            }
            const sequence = Math.trunc(finiteNumber(data.sequence, -1));
            if (sequence <= player.lastInputSeq || sequence > player.lastInputSeq + 10_000) return;
            player.lastInputSeq = sequence;
            let moveX = clamp(finiteNumber(data.moveX), -1, 1);
            let moveY = clamp(finiteNumber(data.moveY), -1, 1);
            const moveLength = Math.hypot(moveX, moveY);
            if (moveLength > 1) { moveX /= moveLength; moveY /= moveLength; }
            let aimX = clamp(finiteNumber(data.aimX, player.aimX), -1, 1);
            let aimY = clamp(finiteNumber(data.aimY, player.aimY), -1, 1);
            const aimLength = Math.hypot(aimX, aimY);
            if (aimLength > 0.01) { aimX /= aimLength; aimY /= aimLength; player.aimX = aimX; player.aimY = aimY; }
            player.input.moveX = moveX;
            player.input.moveY = moveY;
            player.input.aimX = player.aimX;
            player.input.aimY = player.aimY;
            player.input.shooting = data.shooting === true;
            player.input.dash = player.input.dash || data.dash === true;
            if (Object.hasOwn(WEAPONS, data.weapon)) player.weapon = data.weapon;
        });

        socket.on('disconnect', () => {
            markPlayerOffline(socket);
            if (activeIdentities.get(identityId) === socket.id) activeIdentities.delete(identityId);
            if (activeBrowsers.get(browserKey) === socket.id) {
                activeBrowsers.delete(browserKey);
                const remaining = Math.max(0, (activeIpCounts.get(ipKey) || 1) - 1);
                if (remaining) activeIpCounts.set(ipKey, remaining); else activeIpCounts.delete(ipKey);
            }
        });
    });

    let previous = Date.now();
    const timer = setInterval(() => {
        const now = Date.now();
        const dt = Math.min(0.1, (now - previous) / 1000);
        previous = now;
        for (const [code, room] of rooms) {
            for (const [playerId, player] of room.players) {
                if (player.offlineAt && now - player.offlineAt >= OFFLINE_GRACE_MS) room.players.delete(playerId);
            }
            if (room.players.size === 0) {
                if (!room.emptyAt) room.emptyAt = now;
                else if (now - room.emptyAt >= EMPTY_ROOM_TTL_MS) rooms.delete(code);
                continue;
            }
            simulateRoom(room, now, dt);
            if (now - room.snapshotAt >= SNAPSHOT_MS) {
                room.snapshotAt = now;
                arena.to(code).volatile.emit('arena_snapshot', makeSnapshot(room, now));
            }
        }
        if (sessionRates.size > 2048) sessionRates.clear();
        if (browserIdentities.size > 4096) {
            for (const [key, identity] of browserIdentities) if (now - identity.lastSeen > 30 * 60_000) browserIdentities.delete(key);
            if (browserIdentities.size > 4096) browserIdentities.clear();
        }
    }, TICK_MS);
    timer.unref?.();

    return { rooms, namespace: arena };
}

module.exports = { attachArrowArena };
