const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const QRCode = require('qrcode');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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

// Endpoint ElevenLabs (voz premium)
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

// ========= ESTADO GLOBAL =========
let queue = [];
let history = [];
let currentSong = null;
let participants = new Map();
let participantTeams = new Map();
let singerScores = {};
let teamScores = { red: 0, blue: 0 };
let currentSongClaps = 0;
let peakApplause = 0;
let currentSongVotesChacal = new Set();
let activeVoiceEffect = 'normal';
let voiceEffectTimeout = null;
let gameMode = 'teams';

// Decaimiento estilo Guitar Hero
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
    return Object.entries(singerScores).map(([name, score]) => ({ name, score })).sort((a,b) => b.score - a.score);
}

function emitFullState() {
    const participantList = Array.from(participants.entries()).map(([id, name]) => ({ id, name, team: participantTeams.get(id) || null }));
    io.emit('state-update', { queue, currentSong, teamScores, participantList, peakApplause, currentSongClaps, activeVoiceEffect, chacalVoteCount: currentSongVotesChacal.size, chacalVoteRatio: participants.size > 0 ? (currentSongVotesChacal.size / participants.size) : 0, gameMode });
    io.emit('individual-ranking', getIndividualRanking());
}

function nextSong() {
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

async function addSong(videoUrl, requester) {
    const videoId = videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?#]+)/)?.[1];
    if (!videoId) return null;
    try {
        const meta = (await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`)).data;
        const newSong = { id: Date.now().toString(), videoId, title: meta.title, thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, requester };
        queue.push(newSong);
        if (!currentSong) nextSong();
        else emitFullState();
        return newSong;
    } catch(e) { return null; }
}

io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);

    socket.on('join-team', ({ nickname, team }) => {
        if (nickname && (team === 'red' || team === 'blue')) {
            const cleanNick = nickname.trim();
            participants.set(socket.id, cleanNick);
            participantTeams.set(socket.id, team);
            if (singerScores[cleanNick] === undefined) singerScores[cleanNick] = 0;
            socket.emit('nickname-set', { nickname: cleanNick, team });
            io.emit('notification', `${cleanNick} se unió al equipo ${team === 'red' ? 'Rojo 🔴' : 'Azul 🔵'}`);
            emitFullState();
        }
    });

    socket.on('submit-claps', ({ claps, screams }) => {
        const total = (claps || 0) + (screams || 0);
        if (total <= 0) return;
        currentSongClaps = Math.min(100, currentSongClaps + total);
        if (currentSongClaps > peakApplause) peakApplause = currentSongClaps;
        if (currentSong) {
            singerScores[currentSong.requester] = (singerScores[currentSong.requester] || 0) + total;
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
        if (!currentSong) return;
        currentSongVotesChacal.add(socket.id);
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
        // Mantenido por compatibilidad, pero ya no se usa en el mando
        if (['normal', 'reverb', 'helium', 'monster'].includes(effectName)) {
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

    socket.on('add-song', async ({ url, nickname }) => {
        const song = await addSong(url, nickname);
        if (song) io.emit('notification', `${nickname} añadió: ${song.title}`);
        else socket.emit('error-msg', 'Enlace no válido');
    });

    socket.on('trigger-effect', (effectName) => {
        const sender = participants.get(socket.id);
        if (currentSong && currentSong.requester) {
            singerScores[currentSong.requester] = (singerScores[currentSong.requester] || 0) + 1;
            io.emit('individual-ranking', getIndividualRanking());
        }
        io.emit('effect-triggered', { effect: effectName, from: sender || 'Alguien' });
    });

    socket.on('send-sticker', (stickerUrl) => {
        if (currentSong && currentSong.requester) {
            singerScores[currentSong.requester] = (singerScores[currentSong.requester] || 0) + 2;
            io.emit('individual-ranking', getIndividualRanking());
        }
        io.emit('sticker-received', stickerUrl);
    });

    socket.on('get-participants', () => {
        const list = Array.from(participants.entries()).map(([id, name]) => ({ id, name }));
        socket.emit('participants-list', list);
    });

    socket.on('invite-participant', ({ targetSocketId }) => {
        const inviterName = participants.get(socket.id);
        io.to(targetSocketId).emit('receive-invitation', { fromId: socket.id, fromName: inviterName });
    });

    socket.on('accept-invitation', (inviterId) => {
        io.to(inviterId).emit('invitation-accepted', socket.id);
    });

    socket.on('mic-audio', (audioData) => {
        socket.broadcast.emit('mic-audio', audioData);
    });

    socket.on('skip-song', nextSong);
    socket.on('prev-song', () => {
        if (history.length > 0) {
            if (currentSong) queue.unshift(currentSong);
            currentSong = history.pop();
            emitFullState();
            resetDecay();
        }
    });
    socket.on('remove-song', (songId) => {
        queue = queue.filter(s => s.id !== songId);
        emitFullState();
    });
    socket.on('clear-queue', () => {
        queue = [];
        singerScores = {};
        teamScores = { red: 0, blue: 0 };
        participantTeams.clear();
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
        participants.delete(socket.id);
        participantTeams.delete(socket.id);
        emitFullState();
    });
});

app.post('/api/set-mode', (req, res) => {
    const { mode, key } = req.body;
    if (key !== 'admin123') return res.status(403).json({ error: 'Clave inválida' });
    if (mode === 'arcade' || mode === 'teams') {
        gameMode = mode;
        io.emit('game-mode-changed', gameMode);
        emitFullState();
        res.json({ ok: true, mode });
    } else {
        res.status(400).json({ error: 'Modo no válido' });
    }
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

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎤 Servidor Karaoke listo en: http://localhost:${PORT}`);
    console.log(`📱 Invitados: Acceso dinámico escaneando el código QR en la TV`);
});
