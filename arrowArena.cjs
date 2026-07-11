'use strict';

const crypto = require('crypto');

const WORLD_W = 2600;
const WORLD_H = 1800;
const TICK_MS = 1000 / 30;
const SNAPSHOT_MS = 1000 / 20;
const OFFLINE_GRACE_MS = 3 * 60 * 1000;
const MAX_TOTAL_PLAYERS = 160;
const EMPTY_ROOM_TTL_MS = 10_000;
const DASH_COOLDOWN_MS = 1800;
const DASH_ENERGY = 20;
const ENERGY_REGEN_PER_SECOND = 5;
const HIT_PROTECTION_MS = 110;

const WEAPONS = Object.freeze({
    sword: { damage: 50, cooldown: 430, range: 142, speed: 0, life: 0, pierce: 0 },
    bow: { damage: 31, cooldown: 560, range: 820, speed: 760, life: 1100, pierce: 0, hitRadius: 38 },
    pistol: { damage: 13, cooldown: 190, range: 900, speed: 1150, life: 800, pierce: 0, hitRadius: 34 },
    pulse: { damage: 30, cooldown: 450, range: 800, speed: 760, life: 1080, pierce: 1, energy: 9, hitRadius: 42 }
});
const UPGRADE_IDS = Object.freeze(['damage', 'speed', 'health', 'rapid', 'multishot', 'pierce', 'lifesteal', 'dash']);

const WEAPON_TO_IDX = { sword: 0, bow: 1, pistol: 2, pulse: 3 };
const STATE_TO_IDX = { idle: 0, move: 1, attack: 2, dead: 3, offline: 4 };

const AOI_CELL_W = 1300;
const AOI_CELL_H = 900;
const AOI_COLS = Math.ceil(WORLD_W / AOI_CELL_W);
const AOI_ROWS = Math.ceil(WORLD_H / AOI_CELL_H);

function aoiCell(x, y) {
    return clamp(Math.floor(x / AOI_CELL_W), 0, AOI_COLS - 1)
         + clamp(Math.floor(y / AOI_CELL_H), 0, AOI_ROWS - 1) * AOI_COLS;
}

const _aoiCache = new Map();
function aoiVisible(cell) {
    if (_aoiCache.has(cell)) return _aoiCache.get(cell);
    const col = cell % AOI_COLS, row = (cell - col) / AOI_COLS;
    const s = new Set();
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const c = col + dc, r = row + dr;
        if (c >= 0 && c < AOI_COLS && r >= 0 && r < AOI_ROWS) s.add(c + r * AOI_COLS);
    }
    _aoiCache.set(cell, s);
    return s;
}

const BIT_VEL = 1, BIT_AIM = 2, BIT_HP = 4, BIT_NRG = 8, BIT_WS = 16, BIT_SCORE = 32, BIT_COMBAT = 64;
const _snapBuf = Buffer.allocUnsafe(16384);

function snapVals(p) {
    return {
        x: Math.round(p.x), y: Math.round(p.y),
        vx: Math.round(p.vx), vy: Math.round(p.vy),
        ax: Math.round(p.aimX * 127), ay: Math.round(p.aimY * 127),
        hp: Math.round(p.hp), mhp: Math.round(p.maxHp),
        nrg: Math.round(p.energy),
        w: WEAPON_TO_IDX[p.weapon] ?? 1, st: STATE_TO_IDX[p.state] ?? 0,
        k: p.kills, d: p.deaths, seq: p.lastInputSeq, lv: p.level,
        spd: Math.round(p.speed * 10), cd: Math.round(p.cooldownScale * 255),
        ms: p.multishot, pb: p.pierceBonus
    };
}

function deltaM(cur, prev) {
    let m = 0;
    if (cur.vx !== prev.vx || cur.vy !== prev.vy) m |= BIT_VEL;
    if (cur.ax !== prev.ax || cur.ay !== prev.ay) m |= BIT_AIM;
    if (cur.hp !== prev.hp || cur.mhp !== prev.mhp) m |= BIT_HP;
    if (cur.nrg !== prev.nrg) m |= BIT_NRG;
    if (cur.w !== prev.w || cur.st !== prev.st) m |= BIT_WS;
    if (cur.k !== prev.k || cur.d !== prev.d) m |= BIT_SCORE;
    if (cur.seq !== prev.seq || cur.lv !== prev.lv || cur.spd !== prev.spd ||
        cur.cd !== prev.cd || cur.ms !== prev.ms || cur.pb !== prev.pb) m |= BIT_COMBAT;
    return m;
}

function writeFields(buf, o, v, mask) {
    if (mask & BIT_VEL) { buf.writeInt16BE(clamp(v.vx, -32768, 32767), o); o += 2; buf.writeInt16BE(clamp(v.vy, -32768, 32767), o); o += 2; }
    if (mask & BIT_AIM) { buf.writeInt8(clamp(v.ax, -127, 127), o); o += 1; buf.writeInt8(clamp(v.ay, -127, 127), o); o += 1; }
    if (mask & BIT_HP) { buf.writeUInt16BE(v.hp, o); o += 2; buf.writeUInt16BE(v.mhp, o); o += 2; }
    if (mask & BIT_NRG) { buf.writeUInt8(v.nrg, o); o += 1; }
    if (mask & BIT_WS) { buf.writeUInt8(v.w, o); o += 1; buf.writeUInt8(v.st, o); o += 1; }
    if (mask & BIT_SCORE) { buf.writeUInt16BE(v.k, o); o += 2; buf.writeUInt16BE(v.d, o); o += 2; }
    if (mask & BIT_COMBAT) {
        buf.writeUInt32BE(v.seq >>> 0, o); o += 4; buf.writeUInt8(v.lv, o); o += 1;
        buf.writeUInt16BE(v.spd, o); o += 2; buf.writeUInt8(v.cd, o); o += 1;
        buf.writeUInt8(v.ms, o); o += 1; buf.writeUInt8(v.pb, o); o += 1;
    }
    return o;
}

function encodeSnapshot(room, viewer, visPlayers, visProjs, removedIndices, now, full) {
    const buf = _snapBuf;
    let o = 0;
    buf.writeDoubleBE(now, o); o += 8;
    buf.writeUInt8(full ? 1 : 0, o); o += 1;
    buf.writeUInt8(visPlayers.length, o); o += 1;
    for (const p of visPlayers) {
        const idx = room.playerIndexMap.get(p.id);
        if (idx === undefined) continue;
        const cur = snapVals(p);
        buf.writeUInt8(idx, o); o += 1;
        buf.writeUInt16BE(clamp(cur.x, 0, 65535), o); o += 2;
        buf.writeUInt16BE(clamp(cur.y, 0, 65535), o); o += 2;
        const prev = full ? null : viewer._delta?.get(idx);
        const mask = prev ? deltaM(cur, prev) : 0x7F;
        buf.writeUInt8(mask, o); o += 1;
        o = writeFields(buf, o, cur, mask);
        if (!viewer._delta) viewer._delta = new Map();
        viewer._delta.set(idx, cur);
    }
    buf.writeUInt8(Math.min(visProjs.length, 96), o); o += 1;
    let projCount = 0;
    for (const pr of visProjs) {
        if (projCount >= 96) break;
        const ownerIdx = room.playerIndexMap.get(pr.ownerId);
        buf.writeUInt16BE(pr.id & 0xFFFF, o); o += 2;
        buf.writeUInt16BE(Math.round(clamp(pr.x, 0, 65535)), o); o += 2;
        buf.writeUInt16BE(Math.round(clamp(pr.y, 0, 65535)), o); o += 2;
        buf.writeInt16BE(Math.round(clamp(pr.vx, -32768, 32767)), o); o += 2;
        buf.writeInt16BE(Math.round(clamp(pr.vy, -32768, 32767)), o); o += 2;
        buf.writeUInt8(WEAPON_TO_IDX[pr.weapon] ?? 1, o); o += 1;
        buf.writeUInt8(ownerIdx ?? 255, o); o += 1;
        projCount++;
    }
    buf.writeUInt8(removedIndices.length, o); o += 1;
    for (const ri of removedIndices) { buf.writeUInt8(ri, o); o += 1; }
    const result = Buffer.allocUnsafe(o);
    buf.copy(result, 0, 0, o);
    return result;
}

function offerUpgrade(room, player) {
    if (player.pendingUpgrades?.length || !player.socketId) return;
    const pool = [...UPGRADE_IDS];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    player.pendingUpgrades = pool.slice(0, 3);
    room.arena?.to(player.socketId).emit('arena_upgrade_choices', { choices: player.pendingUpgrades, level: player.level });
}

function applyUpgrade(player, id) {
    if (id === 'damage') player.damageScale = Math.min(2.4, player.damageScale * 1.18);
    else if (id === 'speed') player.speed = Math.min(340, player.speed * 1.1);
    else if (id === 'health') { player.maxHp = Math.min(350, player.maxHp + 30); player.hp = Math.min(player.maxHp, player.hp + 40); }
    else if (id === 'rapid') player.cooldownScale = Math.max(0.52, player.cooldownScale * 0.86);
    else if (id === 'multishot') player.multishot = Math.min(4, player.multishot + 1);
    else if (id === 'pierce') player.pierceBonus = Math.min(4, player.pierceBonus + 1);
    else if (id === 'lifesteal') player.lifesteal = Math.min(0.25, player.lifesteal + 0.05);
    else if (id === 'dash') player.dashCooldown = Math.max(850, player.dashCooldown * 0.82);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function finiteNumber(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
}

function pointSegmentDistanceSq(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq <= 0.0001) return (px - x1) ** 2 + (py - y1) ** 2;
    const t = clamp(((px - x1) * dx + (py - y1) * dy) / lengthSq, 0, 1);
    const nearestX = x1 + dx * t;
    const nearestY = y1 + dy * t;
    return (px - nearestX) ** 2 + (py - nearestY) ** 2;
}

function randomPlayerName() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let suffix = '';
    for (let i = 0; i < 8; i++) suffix += alphabet[crypto.randomInt(alphabet.length)];
    return `PLAY-${suffix}`;
}

function uniquePlayerName(identities) {
    const used = new Set(Array.from(identities.values(), identity => identity.playerName));
    for (let attempt = 0; attempt < 20; attempt++) {
        const name = randomPlayerName();
        if (!used.has(name)) return name;
    }
    return `PLAY-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
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
        nextCombatEventId: 1,
        createdAt: Date.now(),
        emptyAt: 0,
        snapshotAt: 0,
        snapshotSeq: 0,
        playerIndexMap: new Map(),
        indexToPlayer: new Map()
    };
}

function chooseSpawn(room) {
    let best = { x: WORLD_W / 2, y: WORLD_H / 2, distanceSq: -1 };
    for (let attempt = 0; attempt < 16; attempt++) {
        const x = crypto.randomInt(120, WORLD_W - 120);
        const y = crypto.randomInt(120, WORLD_H - 120);
        let nearestSq = Number.POSITIVE_INFINITY;
        for (const other of room.players.values()) {
            if (!other.alive || other.offlineAt) continue;
            const dx = other.x - x;
            const dy = other.y - y;
            nearestSq = Math.min(nearestSq, dx * dx + dy * dy);
        }
        if (nearestSq > best.distanceSq) best = { x, y, distanceSq: nearestSq };
        if (nearestSq >= 520 * 520) break;
    }
    return best;
}

function createPlayer(identity, socket, room) {
    const spawn = chooseSpawn(room);
    return {
        id: identity.id,
        browserKey: identity.browserKey,
        socketId: socket.id,
        name: identity.name,
        x: spawn.x,
        y: spawn.y,
        vx: 0, vy: 0, aimX: 1, aimY: 0,
        dashX: 1, dashY: 0,
        hp: 125, maxHp: 125, energy: 100,
        level: 1, speed: 235, damageScale: 1, cooldownScale: 1,
        multishot: 1, pierceBonus: 0, lifesteal: 0, dashCooldown: DASH_COOLDOWN_MS, pendingUpgrades: [],
        weapon: 'bow', state: 'idle', alive: true,
        kills: 0, deaths: 0,
        lastInputSeq: 0, lastShot: 0, lastDash: 0,
        dashUntil: 0, invulnerableUntil: Date.now() + 1000, respawnAt: 0,
        offlineAt: 0,
        inputWindowAt: Date.now(), inputCount: 0, strikes: 0,
        input: { moveX: 0, moveY: 0, aimX: 1, aimY: 0, shooting: false, dash: false },
        _delta: new Map()
    };
}

function getProjectile(room) {
    for (const projectile of room.projectiles) if (!projectile.active) return projectile;
    if (room.projectiles.length >= 96) return null;
    const projectile = { active: false, id: 0, ownerId: '', x: 0, y: 0, vx: 0, vy: 0, damage: 0, expiresAt: 0, weapon: 'bow', pierce: 0, hitRadius: 27, hitIds: new Set() };
    room.projectiles.push(projectile);
    return projectile;
}

function deactivateProjectile(projectile) {
    projectile.active = false;
    projectile.ownerId = '';
    projectile.hitIds.clear();
}

function damagePlayer(room, target, owner, damage, now, weapon) {
    if (!target.alive || target.offlineAt || now < target.invulnerableUntil) return false;
    const previousHp = target.hp;
    target.hp = Math.max(0, target.hp - damage);
    const appliedDamage = previousHp - target.hp;
    if (appliedDamage <= 0) return false;
    if (owner && owner !== target && owner.lifesteal > 0) owner.hp = Math.min(owner.maxHp, owner.hp + appliedDamage * owner.lifesteal);
    target.invulnerableUntil = now + HIT_PROTECTION_MS;
    const killed = target.hp <= 0;
    room.arena?.to(room.code).emit('arena_hit', {
        id: room.nextCombatEventId++,
        targetId: target.id,
        attackerId: owner?.id || '',
        damage: Math.round(appliedDamage),
        hp: Math.round(target.hp),
        killed,
        weapon: weapon || owner?.weapon || 'bow',
        x: Math.round(target.x),
        y: Math.round(target.y),
        time: now
    });
    if (!killed) return true;
    target.alive = false;
    target.state = 'dead';
    target.vx = target.vy = 0;
    target.deaths++;
    target.respawnAt = now + 1500;
    if (owner && owner !== target) {
        owner.kills++;
        const nextLevel = Math.min(30, owner.kills + 1);
        if (nextLevel > owner.level) {
            owner.level = nextLevel;
            offerUpgrade(room, owner);
        }
        // 击杀奖励让战斗保持连续，不必脱离交战等待恢复。
        owner.hp = Math.min(owner.maxHp, owner.hp + 24);
        owner.energy = Math.min(100, owner.energy + 22);
    }
    return true;
}

function useWeapon(room, player, now) {
    const weapon = WEAPONS[player.weapon] || WEAPONS.bow;
    if (now - player.lastShot < weapon.cooldown * player.cooldownScale) return;
    if (weapon.energy && player.energy < weapon.energy) return;
    player.lastShot = now;
    player.state = 'attack';
    if (weapon.energy) player.energy -= weapon.energy;

    if (player.weapon === 'sword') {
        const swordRange = weapon.range * (1 + (player.multishot - 1) * 0.08);
        const rangeSq = swordRange * swordRange;
        for (const target of room.players.values()) {
            if (target === player || !target.alive || target.offlineAt) continue;
            const dx = target.x - player.x;
            const dy = target.y - player.y;
            const distanceSq = dx * dx + dy * dy;
            if (distanceSq > 1 && distanceSq <= rangeSq && (dx * player.aimX + dy * player.aimY) / Math.sqrt(distanceSq) > 0.15) {
                damagePlayer(room, target, player, weapon.damage * player.damageScale * (1 + player.pierceBonus * 0.08), now, player.weapon);
            }
        }
        return;
    }

    const count = player.weapon === 'pulse' ? 1 : player.multishot;
    for (let i = 0; i < count; i++) {
        const projectile = getProjectile(room);
        if (!projectile) break;
        const spread = count === 1 ? 0 : (i - (count - 1) / 2) * (player.weapon === 'pistol' ? 0.075 : 0.11);
        const baseAngle = Math.atan2(player.aimY, player.aimX) + spread;
        const dx = Math.cos(baseAngle), dy = Math.sin(baseAngle);
        projectile.active = true;
        projectile.id = room.nextProjectileId++;
        projectile.ownerId = player.id;
        projectile.x = player.x + dx * 30;
        projectile.y = player.y + dy * 30;
        projectile.vx = dx * weapon.speed;
        projectile.vy = dy * weapon.speed;
        projectile.damage = weapon.damage * player.damageScale;
        projectile.expiresAt = now + weapon.life;
        projectile.weapon = player.weapon;
        projectile.pierce = weapon.pierce + player.pierceBonus;
        projectile.hitRadius = weapon.hitRadius;
        projectile.hitIds.clear();
    }
}

function respawnPlayer(room, player, now) {
    const spawn = chooseSpawn(room);
    player.x = spawn.x;
    player.y = spawn.y;
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
            if (player.respawnAt && now >= player.respawnAt) respawnPlayer(room, player, now);
            continue;
        }

        const input = player.input;
        if (input.dash) {
            input.dash = false;
            if (now - player.lastDash >= player.dashCooldown && player.energy >= DASH_ENERGY) {
                player.lastDash = now;
                player.dashUntil = now + 190;
                player.energy -= DASH_ENERGY;
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
            player.vx = input.moveX * player.speed;
            player.vy = input.moveY * player.speed;
            player.state = Math.abs(input.moveX) + Math.abs(input.moveY) > 0.02 ? 'move' : 'idle';
        }

        player.x = clamp(player.x + player.vx * dt, 35, WORLD_W - 35);
        player.y = clamp(player.y + player.vy * dt, 35, WORLD_H - 35);
        player.energy = Math.min(100, player.energy + ENERGY_REGEN_PER_SECOND * dt);
        if (input.shooting) useWeapon(room, player, now);
    }

    for (const projectile of room.projectiles) {
        if (!projectile.active) continue;
        if (now >= projectile.expiresAt) { deactivateProjectile(projectile); continue; }
        const previousX = projectile.x;
        const previousY = projectile.y;
        projectile.x += projectile.vx * dt;
        projectile.y += projectile.vy * dt;
        if (projectile.x < 0 || projectile.y < 0 || projectile.x > WORLD_W || projectile.y > WORLD_H) { deactivateProjectile(projectile); continue; }
        const owner = room.players.get(projectile.ownerId);
        for (const target of room.players.values()) {
            if (!target.alive || target.offlineAt || target.id === projectile.ownerId || projectile.hitIds.has(target.id)) continue;
            if (pointSegmentDistanceSq(target.x, target.y, previousX, previousY, projectile.x, projectile.y) > projectile.hitRadius * projectile.hitRadius) continue;
            projectile.hitIds.add(target.id);
            damagePlayer(room, target, owner, projectile.damage, now, projectile.weapon);
            if (projectile.pierce-- <= 0) { deactivateProjectile(projectile); break; }
        }
    }
}

function makeSnapshot(room, now) {
    const players = [];
    const projectiles = [];
    for (const player of room.players.values()) {
        if (player.offlineAt) continue;
        players.push([player.id, player.name, Math.round(player.x), Math.round(player.y), Math.round(player.vx), Math.round(player.vy), +player.aimX.toFixed(3), +player.aimY.toFixed(3), Math.round(player.hp), player.maxHp, Math.round(player.energy), player.weapon, player.state, player.kills, player.deaths, player.lastInputSeq, player.level, +player.speed.toFixed(1), +player.cooldownScale.toFixed(3), player.multishot, player.pierceBonus]);
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

    function getOnlinePlayerCount(room) {
        let count = 0;
        for (const player of room.players.values()) if (!player.offlineAt && player.socketId) count++;
        return count;
    }

    function getTotalOnlineCount() {
        let count = 0;
        for (const room of rooms.values()) count += getOnlinePlayerCount(room);
        return count;
    }

    function makeRoomState(room) {
        return { roomCode: room.code, playerCount: getOnlinePlayerCount(room), maxPlayers };
    }

    function broadcastRoomState(room) {
        arena.to(room.code).emit('arena_room_state', makeRoomState(room));
    }

    function assignPlayerIndex(room, playerId) {
        if (room.playerIndexMap.has(playerId)) return room.playerIndexMap.get(playerId);
        for (let i = 0; i < 255; i++) {
            if (!room.indexToPlayer.has(i)) {
                room.indexToPlayer.set(i, playerId);
                room.playerIndexMap.set(playerId, i);
                return i;
            }
        }
        return -1;
    }

    function releasePlayerIndex(room, playerId) {
        const idx = room.playerIndexMap.get(playerId);
        if (idx !== undefined) {
            room.indexToPlayer.delete(idx);
            room.playerIndexMap.delete(playerId);
            for (const p of room.players.values()) if (p._delta) p._delta.delete(idx);
        }
    }

    function getPlayerMapEntries(room) {
        const entries = [];
        for (const [idx, pid] of room.indexToPlayer) {
            const p = room.players.get(pid);
            if (p) entries.push({ index: idx, id: p.id, name: p.name });
        }
        return entries;
    }

    app.get('/arrow-arena/health', (_req, res) => res.json({
        ok: true,
        rooms: rooms.size,
        players: Array.from(rooms.values()).reduce((sum, room) => sum + room.players.size, 0),
        onlinePlayers: getTotalOnlineCount(),
        maxTotalPlayers: MAX_TOTAL_PLAYERS,
        tickRate: Math.round(1000 / TICK_MS),
        snapshotRate: Math.round(1000 / SNAPSHOT_MS),
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
        // 浏览器身份不能绑定 IP：移动网络切换、双栈出口变化和代理漂移都会让
        // Socket.IO 重连被误判成新设备，表现为游戏无故掉线。
        const browserKey = fingerprint(browserId, secret);
        let cached = browserIdentities.get(browserKey);
        if (!cached) cached = { playerId: crypto.randomBytes(18).toString('base64url'), playerName: uniquePlayerName(browserIdentities), lastSeen: now };
        cached.lastSeen = now;
        browserIdentities.set(browserKey, cached);
        const identity = { id: cached.playerId, name: cached.playerName, ipKey, browserKey, exp: now + 24 * 60 * 60_000 };
        res.json({ token: signTicket(identity, secret), playerId: identity.id, name: identity.name, namespace: '/arrow-arena' });
    });

    arena.use((socket, next) => {
        const identity = verifyTicket(socket.handshake.auth?.ticket, secret);
        if (!identity) return next(new Error('Invalid or expired game ticket'));
        const currentIpKey = fingerprint(socketIp(socket), secret);
        const activeSocketId = activeBrowsers.get(identity.browserKey);
        const isReconnect = activeSocketId && arena.sockets.get(activeSocketId)?.connected;
        if (!isReconnect && (activeIpCounts.get(currentIpKey) || 0) >= maxPlayersPerIp) return next(new Error('Too many active game clients from this IP'));
        socket.data.arenaIdentity = { ...identity, ipKey: currentIpKey };
        next();
    });

    function leaveCurrentRoom(socket) {
        const code = socket.data.arenaRoom;
        if (!code) return;
        const room = rooms.get(code);
        if (room) {
            releasePlayerIndex(room, socket.data.arenaIdentity.id);
            room.players.delete(socket.data.arenaIdentity.id);
            if (room.players.size === 0) room.emptyAt = Date.now();
        }
        socket.leave(code);
        socket.data.arenaRoom = '';
        if (room) { broadcastRoomState(room); arena.to(code).emit('arena_player_map', getPlayerMapEntries(room)); }
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
        activeIpCounts.set(ipKey, (activeIpCounts.get(ipKey) || 0) + 1);
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
                existingPlayer.lastInputSeq = 0;
                existingPlayer.inputWindowAt = Date.now();
                existingPlayer.inputCount = 0;
                existingPlayer.strikes = 0;
                existingPlayer._delta.clear();
                existingRoom.emptyAt = 0;
                socket.data.arenaRoom = existingRoom.code;
                socket.join(existingRoom.code);
                assignPlayerIndex(existingRoom, existingPlayer.id);
                arena.to(socket.id).emit('arena_player_map', getPlayerMapEntries(existingRoom));
                const roomState = makeRoomState(existingRoom);
                broadcastRoomState(existingRoom);
                if (existingPlayer.pendingUpgrades?.length) setTimeout(() => existingRoom.arena?.to(existingPlayer.socketId).emit('arena_upgrade_choices', { choices: existingPlayer.pendingUpgrades, level: existingPlayer.level }), 250);
                return acknowledge({ ok: true, roomCode: existingRoom.code, playerId: existingPlayer.id, ...roomState, reconnected: true });
            }
            if (getTotalOnlineCount() >= MAX_TOTAL_PLAYERS) {
                return acknowledge({ ok: false, error: '服务器已满（当前在线 ' + MAX_TOTAL_PLAYERS + ' 人），请稍后再试' });
            }
            let code = cleanRoomCode(data.roomCode);
            let room = code ? rooms.get(code) : null;
            if (!room && !code) {
                let bestRoom = null;
                let bestCount = -1;
                for (const candidate of rooms.values()) {
                    const online = getOnlinePlayerCount(candidate);
                    if (online < maxPlayers && online > bestCount) {
                        bestRoom = candidate;
                        bestCount = online;
                    }
                }
                room = bestRoom;
            }
            if (!room) {
                if (rooms.size >= maxRooms) return acknowledge({ ok: false, error: '服务器已满，请稍后再试' });
                code = code || randomCode(rooms);
                if (!code) return acknowledge({ ok: false, error: '无法创建房间' });
                room = createRoom(code);
                room.arena = arena;
                rooms.set(code, room);
            }
            if (getOnlinePlayerCount(room) >= maxPlayers) return acknowledge({ ok: false, error: '房间人数已满（' + maxPlayers + '/' + maxPlayers + '）' });
            const player = createPlayer(socket.data.arenaIdentity, socket, room);
            room.players.set(player.id, player);
            assignPlayerIndex(room, player.id);
            room.emptyAt = 0;
            socket.data.arenaRoom = room.code;
            socket.join(room.code);
            arena.to(socket.id).emit('arena_player_map', getPlayerMapEntries(room));
            arena.to(room.code).emit('arena_player_map', [{ index: room.playerIndexMap.get(player.id), id: player.id, name: player.name }]);
            const roomState = makeRoomState(room);
            broadcastRoomState(room);
            acknowledge({ ok: true, roomCode: room.code, playerId: player.id, ...roomState });
        });

        socket.on('arena_input', (data) => {
            const room = rooms.get(socket.data.arenaRoom);
            const player = room?.players.get(socket.data.arenaIdentity.id);
            if (!player || !data || typeof data !== 'object') return;
            const now = Date.now();
            if (now - player.inputWindowAt >= 1000) {
                player.inputWindowAt = now;
                player.inputCount = 0;
                // 正常的一秒会恢复一次信用，避免偶发卡顿/补包永久累计到踢线。
                player.strikes = Math.max(0, player.strikes - 1);
            }
            if (++player.inputCount > 40) {
                // 丢弃突发输入即可。Socket.IO 重连或页面恢复时可能瞬间补发，
                // 服务端不应因为这种可恢复抖动主动断开连接。
                player.strikes = Math.min(3, player.strikes + 1);
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

        socket.on('arena_upgrade_select', (data) => {
            const room = rooms.get(socket.data.arenaRoom);
            const player = room?.players.get(socket.data.arenaIdentity.id);
            const id = String(data?.id || '');
            if (!player?.pendingUpgrades?.includes(id)) return;
            applyUpgrade(player, id);
            player.pendingUpgrades = [];
        });

        socket.on('arena_ping', (_data, acknowledge) => {
            const now = Date.now();
            if (now - (socket.data.lastArenaPingAt || 0) < 400 || typeof acknowledge !== 'function') return;
            socket.data.lastArenaPingAt = now;
            acknowledge({ serverTime: now });
        });

        socket.on('disconnect', () => {
            const code = socket.data.arenaRoom;
            markPlayerOffline(socket);
            const room = rooms.get(code);
            if (room) broadcastRoomState(room);
            if (activeIdentities.get(identityId) === socket.id) activeIdentities.delete(identityId);
            if (activeBrowsers.get(browserKey) === socket.id) {
                activeBrowsers.delete(browserKey);
            }
            // 每个成功通过中间件的 socket 都增加过一次计数。旧 socket 被重连
            // 替换时 activeBrowsers 已指向新 socket，也必须在这里独立减回去。
            const remaining = Math.max(0, (activeIpCounts.get(ipKey) || 1) - 1);
            if (remaining) activeIpCounts.set(ipKey, remaining); else activeIpCounts.delete(ipKey);
        });
    });

    let previous = Date.now();
    const timer = setInterval(() => {
        const now = Date.now();
        const dt = Math.min(0.1, (now - previous) / 1000);
        previous = now;
        for (const [code, room] of rooms) {
            for (const [playerId, player] of room.players) {
                if (player.offlineAt && now - player.offlineAt >= OFFLINE_GRACE_MS) {
                    releasePlayerIndex(room, playerId);
                    room.players.delete(playerId);
                }
            }
            if (room.players.size === 0) {
                if (!room.emptyAt) room.emptyAt = now;
                else if (now - room.emptyAt >= EMPTY_ROOM_TTL_MS) rooms.delete(code);
                continue;
            }
            simulateRoom(room, now, dt);
            if (now - room.snapshotAt >= SNAPSHOT_MS) {
                room.snapshotAt = now;
                room.snapshotSeq = (room.snapshotSeq || 0) + 1;
                const isFull = room.snapshotSeq % 60 === 0;

                const cellPlayers = new Map();
                const cellProjs = new Map();
                for (const p of room.players.values()) {
                    if (p.offlineAt) continue;
                    const c = aoiCell(p.x, p.y);
                    let arr = cellPlayers.get(c);
                    if (!arr) { arr = []; cellPlayers.set(c, arr); }
                    arr.push(p);
                }
                for (const pr of room.projectiles) {
                    if (!pr.active) continue;
                    const c = aoiCell(pr.x, pr.y);
                    let arr = cellProjs.get(c);
                    if (!arr) { arr = []; cellProjs.set(c, arr); }
                    arr.push(pr);
                }

                for (const viewer of room.players.values()) {
                    if (!viewer.socketId || viewer.offlineAt) continue;
                    const visCells = aoiVisible(aoiCell(viewer.x, viewer.y));
                    const visPlayers = [];
                    const visIdxSet = new Set();
                    for (const cell of visCells) {
                        const ps = cellPlayers.get(cell);
                        if (ps) for (const p of ps) {
                            visPlayers.push(p);
                            const idx = room.playerIndexMap.get(p.id);
                            if (idx !== undefined) visIdxSet.add(idx);
                        }
                    }
                    const visProjs = [];
                    for (const cell of visCells) {
                        const ps = cellProjs.get(cell);
                        if (ps) for (const pr of ps) visProjs.push(pr);
                    }
                    const removed = [];
                    if (!isFull && viewer._delta) {
                        for (const prevIdx of viewer._delta.keys()) {
                            if (!visIdxSet.has(prevIdx)) { removed.push(prevIdx); viewer._delta.delete(prevIdx); }
                        }
                    }
                    if (isFull && viewer._delta) viewer._delta.clear();
                    const buf = encodeSnapshot(room, viewer, visPlayers, visProjs, removed, now, isFull);
                    arena.to(viewer.socketId).volatile.emit('arena_snapshot', buf);
                }
            }
        }
        if (sessionRates.size > 2048) sessionRates.clear();
        if (browserIdentities.size > 4096) {
            for (const [key, identity] of browserIdentities) if (now - identity.lastSeen > 24 * 60 * 60_000) browserIdentities.delete(key);
            if (browserIdentities.size > 4096) browserIdentities.clear();
        }
    }, TICK_MS);
    timer.unref?.();

    return { rooms, namespace: arena };
}

module.exports = { attachArrowArena };
