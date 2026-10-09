const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const QRCode = require('qrcode');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: "16kb" }));

const GIPHY_API_KEY = process.env.GIPHY_KEY || 'GlVGYHqc3SyXX10B0BwKz1TFyaMc11JB';

app.get('/api/giphy', async (req, res) => {
    const query = req.query.q || 'party';
    try {
        const url = `https://api.giphy.com/v1/stickers/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=9&rating=g`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (error) {
        console.error("Error Giphy:", error.message);
        res.status(500).json({ error: 'Error al conectar con Giphy' });
    }
});

app.post('/api/hablar', async (req, res) => {
    const texto = req.body.texto;
    const apiKey = process.env.ELEVEN_API_KEY;
    const voiceId = process.env.ELEVEN_VOICE_ID || 'pNInz6obbf5pNzyflT4L';
    if (!apiKey) return res.status(500).json({ error: "Falta API Key de ElevenLabs" });
    try {
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: texto, model_id: 'eleven_multilingual_v2' })
        });
        if (!response.ok) throw new Error(`ElevenLabs error: ${response.status}`);
        const audioBuffer = await response.arrayBuffer();
        res.set('Content-Type', 'audio/mpeg');
        res.send(Buffer.from(audioBuffer));
    } catch (error) {
        console.error("Error ElevenLabs:", error.message);
        res.status(500).json({ error: "Fallo la síntesis" });
    }
});

let queue = [];
let history = [];
let currentSong = null;
let participants = new Map();
let participantTeams = new Map();
let singerScores = Object.create(null);
const sessions = new Map();
const pendingInvitations = new Map();
let coSingerIds = new Set();
const HOST_KEY = process.env.HOST_KEY || '';
function validHostKey(key) {
    if (!HOST_KEY || typeof key !== 'string') return false;
    const supplied = Buffer.from(key), expected = Buffer.from(HOST_KEY);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
function isHost(socket) {
    if (socket.data.isHost) return true;
    socket.emit('error-msg', 'Esta acción requiere acceso de anfitrión.'); return false;
}
function canSing(socket) {
    return Boolean(currentSong && socket.data.participantId &&
        (currentSong.requesterId === socket.data.participantId || coSingerIds.has(socket.data.participantId)));
}
function scoreSinger(points) {
    if (!currentSong) return;
    const id = currentSong.requesterId;
    singerScores[id] = (singerScores[id] || 0) + points;
}
let teamScores = { red: 0, blue: 0 };
let currentSongClaps = 0;
let peakApplause = 0;
let currentSongVotesChacal = new Set();
let activeVoiceEffect = 'normal';
let voiceEffectTimeout = null;
let gameMode = 'teams';

let decayTimeout = null;
let decayInterval = null;

function stopDecay() {
    if (decayInterval) { clearInterval(decayInterval); decayInterval = null; }
    if (decayTimeout) { clearTimeout(decayTimeout); decayTimeout = null; }
}

function startDecay() {
    stopDecay();
    if (!currentSong) return;
    decayTimeout = setTimeout(() => {
        decayInterval = setInterval(() => {
            if (currentSongClaps <= 0) {
                stopDecay();
                return;
            }
            let decrement = Math.min(currentSongClaps, 1.2);
            currentSongClaps = Math.max(0, currentSongClaps - decrement);
            io.emit('applause-update', { currentSongClaps, peakApplause, teamScores });
        }, 170);
    }, 2800);
}

function resetDecay() {
    if (!currentSong) return;
    stopDecay();
    startDecay();
}

function getIndividualRanking() {
    return Object.entries(singerScores).map(([id, score]) => ({ id, name: Array.from(sessions.values()).find(session => session.id === id)?.nickname || 'Cantante', score })).sort((a,b) => b.score - a.score);
}

function emitFullState(target = io) {
    const participantList = Array.from(participants.entries()).map(([socketId, name]) => ({
        id: io.sockets.sockets.get(socketId)?.data.participantId, socketId, name,
        team: participantTeams.get(socketId) || null
    }));
    target.emit('state-update', { queue, currentSong, teamScores, participantList,
        coSingerIds: [...coSingerIds], peakApplause, currentSongClaps, activeVoiceEffect,
        chacalVoteCount: currentSongVotesChacal.size,
        chacalVoteRatio: participants.size > 0 ? currentSongVotesChacal.size / participants.size : 0, gameMode });
    target.emit('individual-ranking', getIndividualRanking());
}

function nextSong() {
    coSingerIds.clear(); pendingInvitations.clear();
    if (currentSong) { history.push(currentSong); if (history.length > 20) history.shift(); }
    currentSong = queue.length > 0 ? queue.shift() : null;
    currentSongClaps = 0;
    currentSongVotesChacal.clear();
    peakApplause = 0;
    activeVoiceEffect = 'normal';
    clearTimeout(voiceEffectTimeout);
    resetDecay();
    emitFullState();
}

async function addSong(videoUrl, requester, requesterId) {
    if (typeof videoUrl !== "string" || videoUrl.length > 2048) return null;
    let videoId;
    try {
        const url = new URL(/^https?:\/\//i.test(videoUrl.trim()) ? videoUrl.trim() : 'https://' + videoUrl.trim());
        if (!['https:', 'http:'].includes(url.protocol)) return null;
        if (['youtu.be', 'www.youtu.be'].includes(url.hostname)) videoId = url.pathname.split('/')[1];
        else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
            videoId = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1];
        }
    } catch (_) { return null; }
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) return null;
    try {
        const meta = (await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`, { timeout: 8000 })).data;
        const newSong = { id: crypto.randomUUID(), requesterId, videoId, title: meta.title, thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, requester };
        queue.push(newSong);
        if (!currentSong) nextSong();
        else emitFullState();
        return newSong;
    } catch(e) { return null; }
}

io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);

    socket.on('get-state', () => emitFullState(socket));
    socket.on('authenticate-host', (payload = {}, ack) => {
        socket.data.isHost = validHostKey(payload?.key);
        if (typeof ack === 'function') ack({ ok: socket.data.isHost,
            message: HOST_KEY ? 'Clave incorrecta.' : 'Configura HOST_KEY en el servidor para habilitar los controles.' });
    });
    socket.on('join-team', (payload = {}) => {
        if (!payload || typeof payload !== 'object') return;
        const { nickname, team, sessionToken } = payload;
        if (typeof nickname !== 'string' || !nickname.trim() || !['red', 'blue'].includes(team)) return;
        let session = typeof sessionToken === 'string' ? sessions.get(sessionToken) : null;
        const resumed = Boolean(session);
        if (!session) {
            session = { id: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'), nickname: nickname.trim().slice(0, 40), team };
            sessions.set(session.token, session);
        }
        // A session owns one connection. Refresh/reconnect replaces the previous socket.
        if (session.socketId && session.socketId !== socket.id) {
            io.sockets.sockets.get(session.socketId)?.disconnect(true);
        }
        session.socketId = socket.id;
        socket.data.participantId = session.id;
        participants.set(socket.id, session.nickname);
        participantTeams.set(socket.id, session.team);
        if (singerScores[session.id] === undefined) singerScores[session.id] = 0;
        socket.emit('nickname-set', { nickname: session.nickname, team: session.team,
            participantId: session.id, sessionToken: session.token });
        if (!resumed) io.emit('notification', `${session.nickname} se unió al equipo ${session.team === 'red' ? 'Rojo 🔴' : 'Azul 🔵'}`);
        emitFullState();
    });

    socket.on('submit-claps', (payload = {}) => {
        if (!socket.data.participantId || !payload || typeof payload !== 'object') return;
        const { claps, screams } = payload;
        const total = [claps, screams].reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? Math.min(1, n) : 0), 0);
        if (total <= 0) return;
        currentSongClaps = Math.min(100, currentSongClaps + total);
        if (currentSongClaps > peakApplause) peakApplause = currentSongClaps;
        if (currentSong) {
            scoreSinger(total);
            io.emit('individual-ranking', getIndividualRanking());
        }
        if (gameMode === 'teams') {
            const userTeam = participantTeams.get(socket.id);
            if (userTeam) { teamScores[userTeam] += total; io.emit('team-scores', teamScores); }
        }
        io.emit('applause-update', { currentSongClaps, peakApplause, teamScores });
        resetDecay();
    });

    socket.on('vote-chacal', () => {
        if (!currentSong || !socket.data.participantId) return;
        currentSongVotesChacal.add(socket.data.participantId);
        const voteCount = currentSongVotesChacal.size;
        const voteRatio = participants.size > 0 ? voteCount / participants.size : 0;
        const sender = participants.get(socket.id) || 'Alguien';
        io.emit('chacal-voted', { voter: sender, voteCount, voteRatio });
        if (voteRatio >= 0.5) {
            io.emit('chacal-overwhelming', { voteCount, totalParticipants: participants.size });
            currentSongVotesChacal.clear();
        }
    });

    socket.on('trigger-voice-effect', (effectName) => {
        if (canSing(socket) && ['normal', 'reverb'].includes(effectName)) {
            activeVoiceEffect = effectName;
            const sender = participants.get(socket.id) || 'Alguien';
            io.emit('voice-effect-changed', { effect: effectName, by: sender });
            clearTimeout(voiceEffectTimeout);
            if (effectName !== 'normal') {
                voiceEffectTimeout = setTimeout(() => {
                    activeVoiceEffect = 'normal';
                    io.emit('voice-effect-changed', { effect: 'normal', by: 'Sistema' });
                }, 10000);
            }
        }
    });

    socket.on('request-final-ranking', () => {
        io.emit('show-final-ranking', { individual: getIndividualRanking(), team: gameMode === 'teams' ? teamScores : null });
    });

    socket.on('add-song', async (payload = {}, ack) => {
        const url = payload?.url;
        if (!socket.data.participantId && !socket.data.isHost) {
            if (typeof ack === 'function') ack({ ok: false, message: 'Vuelve a entrar a la sesión antes de añadir una canción.' });
            return;
        }
        const nickname = participants.get(socket.id) || 'Anfitrión';
        const song = await addSong(url, nickname, socket.data.participantId || 'host');
        if (typeof ack === 'function') ack({ ok: Boolean(song), message: song ? 'Canción añadida.' : 'No se pudo añadir el enlace. Comprueba que el video esté disponible.' });
        if (song) io.emit('notification', `${nickname} añadió: ${song.title}`);
        else socket.emit('error-msg', 'Enlace no válido');
    });

    socket.on('trigger-effect', (effectName) => {
        if (!socket.data.participantId || typeof effectName !== 'string' || effectName.length > 30) return;
        const sender = participants.get(socket.id);
        if (currentSong && currentSong.requester) {
            scoreSinger(1);
            io.emit('individual-ranking', getIndividualRanking());
        }
        io.emit('effect-triggered', { effect: effectName, from: sender || 'Alguien' });
    });

    socket.on('send-sticker', (stickerUrl) => {
        if (!socket.data.participantId || typeof stickerUrl !== 'string' || stickerUrl.length > 2048) return;
        try { if (new URL(stickerUrl).protocol !== 'https:') return; } catch (_) { return; }
        if (currentSong && currentSong.requester) {
            scoreSinger(2);
            io.emit('individual-ranking', getIndividualRanking());
        }
        io.emit('sticker-received', stickerUrl);
    });

    socket.on('get-participants', () => {
        const list = Array.from(participants.entries()).map(([id, name]) => ({ id, name }));
        socket.emit('participants-list', list);
    });

    socket.on('invite-participant', (payload = {}) => {
        const targetSocketId = payload?.targetSocketId;
        if (!canSing(socket) || !participants.has(targetSocketId) || targetSocketId === socket.id) return;
        pendingInvitations.set(targetSocketId, { fromId: socket.id, songId: currentSong.id, expires: Date.now() + 60000 });
        io.to(targetSocketId).emit('receive-invitation', { fromId: socket.id, fromName: participants.get(socket.id) });
    });
    socket.on('accept-invitation', (inviterId) => {
        const invitation = pendingInvitations.get(socket.id);
        pendingInvitations.delete(socket.id);
        if (!invitation || invitation.fromId !== inviterId || invitation.songId !== currentSong?.id || invitation.expires < Date.now()) return;
        const inviter = io.sockets.sockets.get(inviterId);
        if (!inviter || !canSing(inviter) || !socket.data.participantId) return;
        coSingerIds.add(socket.data.participantId);
        socket.emit('invitation-accepted', { songId: currentSong.id });
        inviter.emit('invitation-accepted', { songId: currentSong.id });
        emitFullState();
    });
    // Voice stays on the phone. Remote audio is intentionally disabled until a WebRTC mode exists.
    socket.on('skip-song', () => { if (isHost(socket)) nextSong(); });
    socket.on('prev-song', () => {
        if (!isHost(socket)) return;
        if (history.length > 0) {
            coSingerIds.clear(); pendingInvitations.clear();
            if (currentSong) queue.unshift(currentSong);
            currentSong = history.pop();
            emitFullState();
            resetDecay();
        }
    });
    socket.on('remove-song', (songId) => {
        if (!isHost(socket)) return;
        queue = queue.filter(s => s.id !== songId);
        emitFullState();
    });
    socket.on('clear-queue', () => {
        if (!isHost(socket)) return;
        queue = [];
        singerScores = Object.create(null);
        teamScores = { red: 0, blue: 0 };
        currentSongClaps = 0;
        currentSongVotesChacal.clear();
        peakApplause = 0;
        activeVoiceEffect = 'normal';
        clearTimeout(voiceEffectTimeout);
        stopDecay();
        emitFullState();
        io.emit('team-scores', teamScores);
        io.emit('individual-ranking', []);
    });

    socket.on('request-scores', () => {
        socket.emit('team-scores', teamScores);
    });

    socket.on('disconnect', () => {
        pendingInvitations.delete(socket.id);
        currentSongVotesChacal.delete(socket.data.participantId);
        participants.delete(socket.id);
        participantTeams.delete(socket.id);
        emitFullState();
    });
});

io.on('connection', socket => {
    socket.on('set-mode', (payload = {}) => {
        const mode = payload?.mode;
        if (!isHost(socket)) return;
        if (mode === 'arcade' || mode === 'teams') {
            gameMode = mode; io.emit('game-mode-changed', gameMode); emitFullState();
        }
    });
});

app.get('/config', async (req, res) => {
    try {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const participantUrl = `${protocol}://${host}/join.html`;
        const qrBase64 = await QRCode.toDataURL(participantUrl);
        res.json({ qrImage: qrBase64 });
    } catch (err) {
        console.error("Error al generar QR dinámico:", err);
        res.status(500).json({ error: 'Error al generar QR' });
    }
});

if (require.main === module) server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎤 Servidor Karaoke listo en: http://localhost:${PORT}`);
    console.log(`📱 Invitados: Acceso dinámico escaneando el código QR en la TV`);
});

module.exports = { server, io, stopTimers: () => { stopDecay(); clearTimeout(voiceEffectTimeout); } };
