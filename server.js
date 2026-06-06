const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// El código QR y la URL de invitación se generarán de forma dinámica en cada petición en el endpoint /config

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

let queue = [];
let history = [];
let currentSong = null;
let participants = new Map();
let singerScores = {};

// Nuevas variables de estado para el Modo Desafío y el Aplausómetro
let participantTeams = new Map(); // socket.id -> 'red' | 'blue'
let teamScores = { red: 0, blue: 0 };
let currentSongClaps = 0; // Puntos del aplausómetro acumulados en la canción activa (0-100)
let currentSongVotesChacal = new Set(); // socket.ids que votaron Chacal en esta canción
let peakApplause = 0; // Pico máximo alcanzado del aplausómetro en esta canción

// Estado para los Efectos de Voz
let activeVoiceEffect = 'normal'; // 'normal' | 'reverb' | 'helium' | 'monster'
let voiceEffectTimeout = null;

// Decaimiento del Aplausómetro (4% por segundo)
setInterval(() => {
    if (currentSong && currentSongClaps > 0) {
        currentSongClaps = Math.max(0, currentSongClaps - 4);
        io.emit('applause-update', { 
            currentSongClaps, 
            peakApplause, 
            teamScores 
        });
    }
}, 1000);

function getFullLeaderboard() {
    return Object.entries(singerScores)
        .map(([name, score]) => ({ name, score }))
        .sort((a, b) => b.score - a.score);
}

function emitFullState() {
    const participantList = Array.from(participants.entries()).map(([id, name]) => ({
        id,
        name,
        team: participantTeams.get(id) || null
    }));
    io.emit('state-update', { 
        queue, 
        currentSong, 
        teamScores,
        participantList,
        peakApplause,
        currentSongClaps,
        activeVoiceEffect,
        chacalVoteCount: currentSongVotesChacal.size,
        chacalVoteRatio: participants.size > 0 ? (currentSongVotesChacal.size / participants.size) : 0
    });
}

function nextSong() {
    if (currentSong) {
        history.push(currentSong);
        if (history.length > 20) history.shift();
    }
    currentSong = queue.length > 0 ? queue.shift() : null;
    currentSongClaps = 0;
    currentSongVotesChacal.clear();
    peakApplause = 0;
    
    // Resetear efecto de voz
    activeVoiceEffect = 'normal';
    clearTimeout(voiceEffectTimeout);
    
    emitFullState();
}

async function addSong(videoUrl, requester) {
    const videoId = videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?#]+)/)?.[1];
    if (!videoId) return null;
    try {
        const meta = (await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`)).data;
        const newSong = {
            id: Date.now().toString(),
            videoId,
            title: meta.title,
            thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
            requester
        };
        queue.push(newSong);
        if (!currentSong) nextSong();
        else emitFullState();
        return newSong;
    } catch(e) { return null; }
}

io.on('connection', (socket) => {
    socket.on('ping', () => {});

    socket.on('set-nickname', (nickname) => {
        if (nickname) {
            const cleanNick = nickname.trim();
            participants.set(socket.id, cleanNick);
            if (singerScores[cleanNick] === undefined) singerScores[cleanNick] = 0;
            socket.emit('nickname-set', cleanNick);
            emitFullState();
        }
    });

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

    // Clics batched del aplausómetro
    socket.on('submit-claps', ({ claps, screams }) => {
        const totalClicks = (claps || 0) + (screams || 0);
        if (totalClicks <= 0) return;
        
        currentSongClaps = Math.min(100, currentSongClaps + totalClicks);
        if (currentSongClaps > peakApplause) {
            peakApplause = currentSongClaps;
        }

        if (currentSong) {
            const singerNick = currentSong.requester;
            let singerTeam = null;
            for (const [id, nick] of participants.entries()) {
                if (nick === singerNick) {
                    singerTeam = participantTeams.get(id);
                    break;
                }
            }
            // Sumar puntos al cantante
            singerScores[singerNick] = (singerScores[singerNick] || 0) + totalClicks;
            
            // Sumar puntos al equipo del cantante
            if (singerTeam) {
                teamScores[singerTeam] += totalClicks;
            }
        }

        io.emit('applause-update', { 
            currentSongClaps, 
            peakApplause, 
            teamScores 
        });
    });

    // Votación del Chacal de la Trompeta
    socket.on('vote-chacal', () => {
        if (!currentSong) return;
        
        currentSongVotesChacal.add(socket.id);
        
        const voteCount = currentSongVotesChacal.size;
        const totalParticipants = participants.size;
        const voteRatio = totalParticipants > 0 ? (voteCount / totalParticipants) : 0;
        
        const sender = participants.get(socket.id) || 'Alguien';

        io.emit('chacal-voted', { 
            voter: sender,
            voteCount, 
            voteRatio 
        });

        if (voteRatio >= 0.5) {
            io.emit('chacal-overwhelming', { 
                voteCount, 
                totalParticipants 
            });
            currentSongVotesChacal.clear();
        }
    });

    // Modulador de voz del Cantante (Activo por 10 segundos)
    socket.on('trigger-voice-effect', (effectName) => {
        if (['normal', 'reverb', 'helium', 'monster'].includes(effectName)) {
            activeVoiceEffect = effectName;
            const sender = participants.get(socket.id) || 'Alguien';

            io.emit('voice-effect-changed', { 
                effect: effectName, 
                by: sender 
            });

            clearTimeout(voiceEffectTimeout);
            if (effectName !== 'normal') {
                voiceEffectTimeout = setTimeout(() => {
                    activeVoiceEffect = 'normal';
                    io.emit('voice-effect-changed', { 
                        effect: 'normal', 
                        by: 'Sistema' 
                    });
                }, 10000); // 10 segundos de efecto
            }
        }
    });

    socket.on('request-final-ranking', () => {
        io.emit('show-final-ranking', { fullRanking: getFullLeaderboard(), top3: getFullLeaderboard().slice(0, 3) });
    });

    socket.on('get-state', () => emitFullState());

    socket.on('add-song', async ({ url, nickname }) => {
        const song = await addSong(url, nickname);
        if (song) io.emit('notification', `${nickname} añadió: ${song.title}`);
        else socket.emit('error-msg', 'Enlace no válido');
    });

    // --- MANEJO DE EFECTOS Y PUNTAJES ---
    socket.on('trigger-effect', (effectName) => {
        const sender = participants.get(socket.id);
        if (currentSong && currentSong.requester) singerScores[currentSong.requester] = (singerScores[currentSong.requester] || 0) + 1;
        io.emit('effect-triggered', { effect: effectName, from: sender || 'Alguien' });
    });

    socket.on('send-sticker', (stickerUrl) => {
        if (currentSong && currentSong.requester) singerScores[currentSong.requester] = (singerScores[currentSong.requester] || 0) + 2;
        io.emit('sticker-received', stickerUrl);
    });

    // --- MANEJO DE INVITACIONES SOCIALES ---
    socket.on('get-participants', () => {
        const participantsList = Array.from(participants.entries()).map(([id, name]) => ({ id, name }));
        socket.emit('participants-list', participantsList);
    });

    socket.on('invite-participant', ({ targetSocketId }) => {
        const inviterName = participants.get(socket.id);
        io.to(targetSocketId).emit('receive-invitation', { fromId: socket.id, fromName: inviterName });
    });

    socket.on('accept-invitation', (inviterId) => {
        io.to(inviterId).emit('invitation-accepted', socket.id);
    });

    // --- MANEJO DEL MICRÓFONO EN TIEMPO REAL ---
    socket.on('mic-audio', (audioData) => {
        // Redirige los paquetes de audio a todos los demás dispositivos conectados (La TV)
        socket.broadcast.emit('mic-audio', audioData);
    });

    // --- CONTROLES DE REPRODUCCIÓN ---
    socket.on('skip-song', nextSong);
    socket.on('prev-song', () => {
        if (history.length > 0) {
            if (currentSong) queue.unshift(currentSong);
            currentSong = history.pop();
            emitFullState();
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
        emitFullState();
    });

    socket.on('disconnect', () => {
        participants.delete(socket.id);
        participantTeams.delete(socket.id);
        emitFullState();
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

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎤 Servidor Karaoke listo en: http://localhost:${PORT}`);
    console.log(`📱 Invitados: Acceso dinámico escaneando el código QR en la TV`);
});