const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");
const QRCode = require("qrcode");
const axios = require("axios");
const crypto = require("crypto");
const { Party } = require("./lib/party");
const { SessionStore, validateSnapshot } = require("./lib/session-store");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "16kb" }));

const GIPHY_API_KEY = process.env.GIPHY_KEY || "";

app.get("/api/giphy", async (req, res) => {
  if (!GIPHY_API_KEY)
    return res
      .status(503)
      .json({
        error:
          "Stickers no configurados: el anfitrión debe establecer GIPHY_KEY.",
      });
  const query = req.query.q || "party";
  try {
    const url = `https://api.giphy.com/v1/stickers/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=9&rating=g`;
    const response = await axios.get(url);
    res.json(response.data);
  } catch (error) {
    console.error("Error Giphy:", error.message);
    res.status(500).json({ error: "Error al conectar con Giphy" });
  }
});

app.post("/api/hablar", async (req, res) => {
  const texto = req.body.texto;
  const apiKey = process.env.ELEVEN_API_KEY;
  const voiceId = process.env.ELEVEN_VOICE_ID || "pNInz6obbf5pNzyflT4L";
  if (!apiKey)
    return res.status(500).json({ error: "Falta API Key de ElevenLabs" });
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: texto,
          model_id: "eleven_multilingual_v2",
        }),
      },
    );
    if (!response.ok) throw new Error(`ElevenLabs error: ${response.status}`);
    const audioBuffer = await response.arrayBuffer();
    res.set("Content-Type", "audio/mpeg");
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
const sessions = new Map();
const pendingInvitations = new Map();
let coSingerIds = new Set();
const HOST_KEY = process.env.HOST_KEY || "";
function validHostKey(key) {
  if (!HOST_KEY || typeof key !== "string") return false;
  const supplied = Buffer.from(key),
    expected = Buffer.from(HOST_KEY);
  return (
    supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected)
  );
}
function isHost(socket) {
  if (socket.data.isHost) return true;
  socket.emit("error-msg", "Esta acción requiere acceso de anfitrión.");
  return false;
}
function canSing(socket) {
  return Boolean(
    currentSong &&
    socket.data.participantId &&
    (currentSong.requesterId === socket.data.participantId ||
      coSingerIds.has(socket.data.participantId)),
  );
}
let teamScores = { red: 0, blue: 0 };
let currentSongClaps = 0;
let peakApplause = 0;
let currentSongVotesChacal = new Set();
let activeVoiceEffect = "normal";
let voiceEffectTimeout = null;
let gameMode = "arcade";
let chacalMode = "fiesta",
  allowBoo = false,
  lastChacalAt = 0,
  lastSoundAt = 0;

const store = new SessionStore(
  process.env.SESSION_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH,
);
let party = new Party();
function snapshot() {
  return {
    version: 1,
    savedAt: Date.now(),
    queue,
    history,
    currentSong,
    sessions: [...sessions.values()].map(({ id, token, nickname, team }) => ({
      id,
      token,
      nickname,
      team,
    })),
    party: party.snapshot(),
    teamScores,
    gameMode,
    chacalMode,
    allowBoo,
  };
}
function restore(data) {
  validateSnapshot(data);
  queue = data.queue;
  history = data.history;
  currentSong = data.currentSong;
  sessions.clear();
  data.sessions.forEach((s) => sessions.set(s.token, s));
  party = new Party(data.party);
  teamScores = data.teamScores;
  gameMode = data.gameMode;
  chacalMode = data.chacalMode;
  allowBoo = data.allowBoo;
  coSingerIds = new Set(currentSong?.singerIds?.slice(1) || []);
  party.closeDue();
}
const saved = store.read();
if (saved) restore(saved);
function persist() {
  return store.write(snapshot());
}
function audienceIds() {
  return [
    ...new Set(
      [...io.sockets.sockets.values()]
        .map((s) => s.data.participantId)
        .filter(Boolean),
    ),
  ];
}
function persistenceState() {
  return {
    configured: Boolean(store.directory),
    savedAt: store.savedAt,
    error: store.error,
  };
}
const partyTimer = setInterval(() => {
  if (party.closeDue()) {
    persist();
    emitFullState();
  }
}, 1000);
partyTimer.unref();

let decayTimeout = null;
let decayInterval = null;

function stopDecay() {
  if (decayInterval) {
    clearInterval(decayInterval);
    decayInterval = null;
  }
  if (decayTimeout) {
    clearTimeout(decayTimeout);
    decayTimeout = null;
  }
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
      io.emit("applause-update", {
        currentSongClaps,
        peakApplause,
        teamScores,
      });
    }, 170);
  }, 2800);
}

function resetDecay() {
  if (!currentSong) return;
  stopDecay();
  startDecay();
}

function getIndividualRanking() {
  return party.ranking();
}

function emitFullState(target = io) {
  if (target === io) persist();
  const participantList = Array.from(participants.entries()).map(
    ([socketId, name]) => ({
      id: io.sockets.sockets.get(socketId)?.data.participantId,
      socketId,
      name,
      team: participantTeams.get(socketId) || null,
    }),
  );
  target.emit("state-update", {
    queue,
    currentSong,
    teamScores,
    participantList,
    coSingerIds: [...coSingerIds],
    peakApplause,
    currentSongClaps,
    activeVoiceEffect,
    chacalVoteCount: currentSongVotesChacal.size,
    chacalVoteRatio:
      participants.size > 0
        ? currentSongVotesChacal.size / participants.size
        : 0,
    gameMode,
    stickersAvailable: Boolean(GIPHY_API_KEY),
    chacalMode,
    allowBoo,
    lighting: party.lighting,
    persistence: persistenceState(),
    ranking: party.ranking(),
    duetRanking: party.ranking("duet"),
    duels: party.publicDuels(),
    support: party.active
      ? {
          songId: party.active.songId,
          votes: party.active.votes,
          eligible: party.active.eligible,
        }
      : null,
  });
  target.emit("individual-ranking", getIndividualRanking());
}

function nextSong(completed = false) {
  party.finish(currentSong, completed, audienceIds());
  queue = queue.filter(
    (song) =>
      !song.duelId ||
      party.duels.find((d) => d.id === song.duelId)?.status !== "cancelled",
  );
  coSingerIds.clear();
  pendingInvitations.clear();
  if (currentSong) {
    history.push(currentSong);
    if (history.length > 20) history.shift();
  }
  currentSong = queue.length > 0 ? queue.shift() : null;
  if (currentSong?.kind === "duet")
    coSingerIds = new Set(currentSong.singerIds.slice(1));
  party.start(currentSong, audienceIds());
  currentSongClaps = 0;
  currentSongVotesChacal.clear();
  lastChacalAt = 0;
  peakApplause = 0;
  activeVoiceEffect = "normal";
  clearTimeout(voiceEffectTimeout);
  resetDecay();
  emitFullState();
}

function parseVideo(videoUrl) {
  if (typeof videoUrl !== "string" || videoUrl.length > 2048) return null;
  let videoId;
  try {
    const url = new URL(
      /^https?:\/\//i.test(videoUrl.trim())
        ? videoUrl.trim()
        : "https://" + videoUrl.trim(),
    );
    if (!["https:", "http:"].includes(url.protocol)) return null;
    if (["youtu.be", "www.youtu.be"].includes(url.hostname))
      videoId = url.pathname.split("/")[1];
    else if (
      [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
      ].includes(url.hostname)
    ) {
      videoId =
        url.pathname === "/watch"
          ? url.searchParams.get("v")
          : url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1];
    }
  } catch (_) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) return null;
  return videoId;
}
async function makeSong(videoId, requester, requesterId) {
  let title = `Video de YouTube (${videoId})`,
    metadataAvailable = false;
  try {
    const meta = (
      await axios.get(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`,
        { timeout: 5000 },
      )
    ).data;
    if (typeof meta.title === "string" && meta.title.trim()) {
      title = meta.title.trim().slice(0, 500);
      metadataAvailable = true;
    }
  } catch (_) {
    console.warn(
      "YouTube: título no disponible; se añade el enlace con título provisional.",
    );
  }
  const newSong = {
    id: crypto.randomUUID(),
    requesterId,
    videoId,
    title,
    metadataAvailable,
    thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    requester,
  };
  return newSong;
}
async function addSong(videoUrl, requester, requesterId) {
  const videoId = parseVideo(videoUrl);
  if (!videoId || queue.length >= 200) return null;
  const newSong = await makeSong(videoId, requester, requesterId);
  if (queue.length >= 200) return null;
  queue.push(newSong);
  if (!currentSong) nextSong();
  else emitFullState();
  return newSong;
}

io.on("connection", (socket) => {
  console.log("Cliente conectado:", socket.id);

  socket.on("get-state", () => emitFullState(socket));
  socket.on("authenticate-host", (payload = {}, ack) => {
    socket.data.isHost = validHostKey(payload?.key);
    if (typeof ack === "function")
      ack({
        ok: socket.data.isHost,
        message: HOST_KEY
          ? "Clave incorrecta."
          : "Configura HOST_KEY en el servidor para habilitar los controles.",
      });
  });
  socket.on('register-show', () => { socket.data.isShow = true; });
  socket.on('show-command', (payload = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!socket.data.isHost) return reply({ok:false, message:'Esta acción requiere acceso de anfitrión.'});
    if (!['cinema', 'play-pause'].includes(payload?.action) ||
        (payload.action === 'cinema' && typeof payload.enabled !== 'boolean'))
      return reply({ok:false, message:'Control no válido.'});
    const screens = [...io.sockets.sockets.values()].filter(client => client.data.isShow);
    if (!screens.length) return reply({ok:false, message:'Abre la pantalla del show antes de usar este control.'});
    let pending = screens.length, success = false;
    for (const screen of screens) screen.timeout(5000).emit('show-command',
      {action:payload.action, enabled:payload.enabled}, (error, result) => {
        pending--;
        if (!success && !error && result?.ok) { success = true; reply(result); }
        if (!pending && !success) reply({ok:false, message:'La pantalla no respondió o el reproductor no está listo.'});
      });
  });
  socket.on("join-team", (payload = {}) => {
    if (!payload || typeof payload !== "object") return;
    const { nickname, team, sessionToken } = payload;
    if (
      typeof nickname !== "string" ||
      !nickname.trim() ||
      ![null, undefined, "red", "blue"].includes(team)
    )
      return;
    if (sessions.size >= 500 && !sessions.has(sessionToken))
      return socket.emit(
        "error-msg",
        "La sesión llegó al límite de participantes.",
      );
    let session =
      typeof sessionToken === "string" ? sessions.get(sessionToken) : null;
    const resumed = Boolean(session);
    if (!session) {
      session = {
        id: crypto.randomUUID(),
        token: crypto.randomBytes(32).toString("hex"),
        nickname: nickname.trim().slice(0, 40),
        team: gameMode === "teams" ? team || null : null,
      };
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
    party.addAudience([session.id]);
    socket.emit("nickname-set", {
      nickname: session.nickname,
      team: session.team,
      participantId: session.id,
      sessionToken: session.token,
    });
    if (!resumed)
      io.emit("notification", `${session.nickname} se unió al show`);
    emitFullState();
  });

  socket.on("choose-team", (payload = {}, ack = () => {}) => {
    const team = payload?.team;
    if (!socket.data.participantId)
      return ack({ ok: false, message: "Entra al show primero." });
    if (![null, "red", "blue"].includes(team) || (team && gameMode !== "teams"))
      return ack({ ok: false, message: "Los equipos no están activos." });
    const session = [...sessions.values()].find(
      (item) => item.id === socket.data.participantId,
    );
    if (!session)
      return ack({ ok: false, message: "Vuelve a entrar al show." });
    session.team = team;
    participantTeams.set(socket.id, team);
    socket.emit("team-chosen", { team });
    ack({
      ok: true,
      message: team
        ? "Equipo elegido. Puedes cambiarlo o seguir libre."
        : "Participación libre.",
    });
    emitFullState();
  });

  socket.on("submit-claps", (payload = {}) => {
    if (!socket.data.participantId || !payload || typeof payload !== "object")
      return;
    const { claps, screams } = payload;
    const total = [claps, screams].reduce(
      (sum, n) => sum + (Number.isFinite(n) && n > 0 ? Math.min(1, n) : 0),
      0,
    );
    if (total <= 0) return;
    currentSongClaps = Math.min(100, currentSongClaps + total);
    if (currentSongClaps > peakApplause) peakApplause = currentSongClaps;
    if (currentSong) {
      io.emit("individual-ranking", getIndividualRanking());
    }
    if (gameMode === "teams") {
      const userTeam = participantTeams.get(socket.id);
      if (userTeam) {
        teamScores[userTeam] += total;
        io.emit("team-scores", teamScores);
      }
    }
    io.emit("applause-update", { currentSongClaps, peakApplause, teamScores });
    resetDecay();
  });

  socket.on("set-chacal-options", (payload = {}, ack) => {
    if (!isHost(socket)) {
      if (typeof ack === "function")
        ack({ ok: false, message: "Requiere acceso de anfitrión." });
      return;
    }
    if (
      !["fiesta", "competencia"].includes(payload?.mode) ||
      typeof payload?.allowBoo !== "boolean"
    ) {
      if (typeof ack === "function")
        ack({ ok: false, message: "Opciones no válidas." });
      return;
    }
    chacalMode = payload.mode;
    allowBoo = payload.allowBoo;
    currentSongVotesChacal.clear();
    lastChacalAt = 0;
    emitFullState();
    if (typeof ack === "function")
      ack({ ok: true, message: "Reacciones actualizadas." });
  });
  socket.on("vote-chacal", (ack) => {
    const reply = (message) => {
      if (typeof ack === "function") ack({ message });
    };
    if (!currentSong || !socket.data.participantId)
      return reply("Añade una canción para llamar al Chacal.");
    if (chacalMode === "competencia" && Date.now() - lastChacalAt < 6000)
      return reply("Espera unos segundos antes de una nueva ronda del Chacal.");
    if (currentSongVotesChacal.has(socket.data.participantId))
      return reply("Ya llamaste al Chacal en esta ronda.");
    currentSongVotesChacal.add(socket.data.participantId);
    const voteCount = currentSongVotesChacal.size;
    const voteRatio = participants.size > 0 ? voteCount / participants.size : 0;
    const sender = participants.get(socket.id) || "Alguien";
    const now = Date.now();
    if (
      chacalMode === "competencia" &&
      voteRatio >= 0.5 &&
      now - lastChacalAt >= 6000
    ) {
      lastChacalAt = now;
      io.emit("chacal-overwhelming", {
        voteCount,
        totalParticipants: participants.size,
        songId: currentSong.id,
      });
      currentSongVotesChacal.clear();
    } else if (chacalMode === "fiesta" && now - lastChacalAt >= 6000) {
      lastChacalAt = now;
      io.emit("chacal-voted", { voter: sender, voteCount, voteRatio });
    }
    reply(
      chacalMode === "fiesta"
        ? "El Chacal recibió tu llamada. Las reacciones suenan con una pausa entre ellas."
        : "Voto del Chacal recibido.",
    );
  });

  socket.on("trigger-voice-effect", (effectName) => {
    if (canSing(socket) && ["normal", "reverb"].includes(effectName)) {
      activeVoiceEffect = effectName;
      const sender = participants.get(socket.id) || "Alguien";
      io.emit("voice-effect-changed", { effect: effectName, by: sender });
      clearTimeout(voiceEffectTimeout);
      if (effectName !== "normal") {
        voiceEffectTimeout = setTimeout(() => {
          activeVoiceEffect = "normal";
          io.emit("voice-effect-changed", { effect: "normal", by: "Sistema" });
        }, 10000);
      }
    }
  });

  socket.on("request-final-ranking", () => {
    if (!isHost(socket)) return;
    io.emit("show-final-ranking", {
      individual: getIndividualRanking().filter((r) => !r.provisional),
      duets: party.ranking("duet").filter((r) => !r.provisional),
      team: gameMode === "teams" ? teamScores : null,
    });
  });

  socket.on("add-song", async (payload = {}, ack) => {
    const url = payload?.url;
    if (!socket.data.participantId && !socket.data.isHost) {
      if (typeof ack === "function")
        ack({
          ok: false,
          message: "Vuelve a entrar a la sesión antes de añadir una canción.",
        });
      return;
    }
    const nickname = participants.get(socket.id) || "Anfitrión";
    const song = await addSong(
      url,
      nickname,
      socket.data.participantId || "host",
    );
    if (typeof ack === "function")
      ack({
        ok: Boolean(song),
        message: song
          ? song.metadataAvailable
            ? "Canción añadida."
            : "Enlace añadido con título provisional. Comprueba la reproducción en la pantalla del show."
          : "Enlace no válido. Copia el enlace de un video de YouTube.",
      });
    if (song) io.emit("notification", `${nickname} añadió: ${song.title}`);
    else socket.emit("error-msg", "Enlace no válido");
  });

  socket.on("trigger-effect", (effectName, ack = () => {}) => {
    if (
      (!socket.data.participantId && !socket.data.isHost) ||
      typeof effectName !== "string" ||
      effectName.length > 30
    )
      return ack({
        ok: false,
        message: "Entra al show para enviar una reacción válida.",
      });
    if (
      [
        "ovacion",
        "aplausos",
        "abucheo",
        "multitud",
        "animo",
        "silbido",
        "zampona",
      ].includes(effectName)
    ) {
      if (effectName === "abucheo" && !allowBoo)
        return ack({
          ok: false,
          message: "El anfitrión desactivó el abucheo.",
        });
      if (Date.now() - lastSoundAt < 6000)
        return ack({
          ok: false,
          message: "Espera unos segundos entre sonidos.",
        });
      lastSoundAt = Date.now();
    }
    const sender = participants.get(socket.id);
    if (currentSong && currentSong.requester) {
      io.emit("individual-ranking", getIndividualRanking());
    }
    io.emit("effect-triggered", {
      effect: effectName,
      from: sender || "Alguien",
    });
    ack({ ok: true, message: "Reacción enviada al show." });
  });

  socket.on("send-sticker", (stickerUrl) => {
    if (
      !socket.data.participantId ||
      typeof stickerUrl !== "string" ||
      stickerUrl.length > 2048
    )
      return;
    try {
      if (new URL(stickerUrl).protocol !== "https:") return;
    } catch (_) {
      return;
    }
    if (currentSong && currentSong.requester) {
      io.emit("individual-ranking", getIndividualRanking());
    }
    io.emit("sticker-received", stickerUrl);
  });

  socket.on("get-participants", () => {
    const list = Array.from(participants.entries()).map(([id, name]) => ({
      id,
      name,
    }));
    socket.emit("participants-list", list);
  });

  socket.on("invite-participant", (payload = {}) => {
    const targetSocketId = payload?.targetSocketId;
    if (
      currentSong?.duelId ||
      currentSong?.kind === "duet" ||
      !canSing(socket) ||
      !participants.has(targetSocketId) ||
      targetSocketId === socket.id
    )
      return;
    pendingInvitations.set(targetSocketId, {
      fromId: socket.id,
      songId: currentSong.id,
      expires: Date.now() + 60000,
    });
    io.to(targetSocketId).emit("receive-invitation", {
      fromId: socket.id,
      fromName: participants.get(socket.id),
    });
  });
  socket.on("accept-invitation", (inviterId) => {
    const invitation = pendingInvitations.get(socket.id);
    pendingInvitations.delete(socket.id);
    if (
      !invitation ||
      invitation.fromId !== inviterId ||
      invitation.songId !== currentSong?.id ||
      invitation.expires < Date.now()
    )
      return;
    const inviter = io.sockets.sockets.get(inviterId);
    if (!inviter || !canSing(inviter) || !socket.data.participantId) return;
    coSingerIds.add(socket.data.participantId);
    currentSong.singerIds = [currentSong.requesterId, ...coSingerIds];
    currentSong.kind = "duet";
    currentSong.requester = [
      currentSong.requester,
      participants.get(socket.id),
    ].join(" + ");
    if (party.active) {
      party.active.singers = currentSong.singerIds;
      party.active.kind = "duet";
      party.active.eligible = party.active.eligible.filter(
        (id) => !coSingerIds.has(id),
      );
      party.active.votes = party.active.votes.filter(
        (id) => !coSingerIds.has(id),
      );
    }
    socket.emit("invitation-accepted", { songId: currentSong.id });
    inviter.emit("invitation-accepted", { songId: currentSong.id });
    emitFullState();
  });
  // Voice stays on the phone. Remote audio is intentionally disabled until a WebRTC mode exists.
  socket.on("finish-song", (payload = {}) => {
    if (isHost(socket) && payload.songId === currentSong?.id) nextSong(true);
  });
  socket.on("skip-song", () => {
    if (isHost(socket)) nextSong();
  });
  socket.on("prev-song", () => {
    if (!isHost(socket)) return;
    if (currentSong?.duelId)
      return socket.emit(
        "error-msg",
        "Usa Siguiente para cancelar un duelo; no se puede retroceder durante sus actuaciones.",
      );
    const previousIndex = history.findLastIndex((song) => !song.duelId);
    if (previousIndex < 0) return;
    party.finish(currentSong, false, audienceIds());
    coSingerIds.clear();
    pendingInvitations.clear();
    if (currentSong) queue.unshift(currentSong);
    currentSong = {
      ...history.splice(previousIndex, 1)[0],
      id: crypto.randomUUID(),
    };
    if (currentSong.kind === "duet")
      coSingerIds = new Set(currentSong.singerIds.slice(1));
    party.start(currentSong, audienceIds());
    currentSongClaps = 0;
    peakApplause = 0;
    currentSongVotesChacal.clear();
    lastChacalAt = 0;
    activeVoiceEffect = "normal";
    clearTimeout(voiceEffectTimeout);
    emitFullState();
    resetDecay();
  });
  socket.on("remove-song", (songId) => {
    if (!isHost(socket)) return;
    const removed = queue.find((s) => s.id === songId);
    party.cancel(removed);
    queue = queue.filter(
      (s) =>
        s.id !== songId && (!removed?.duelId || s.duelId !== removed.duelId),
    );
    emitFullState();
  });
  socket.on("clear-queue", () => {
    if (!isHost(socket)) return;
    queue = [];
    party = new Party({ lighting: party.lighting });
    history = [];
    if (currentSong) {
      currentSong = {
        ...currentSong,
        id: crypto.randomUUID(),
        kind: "solo",
        duelId: null,
        singerIds: [currentSong.requesterId],
      };
      coSingerIds.clear();
      party.start(currentSong, audienceIds());
    }
    teamScores = { red: 0, blue: 0 };
    currentSongClaps = 0;
    currentSongVotesChacal.clear();
    peakApplause = 0;
    activeVoiceEffect = "normal";
    clearTimeout(voiceEffectTimeout);
    stopDecay();
    emitFullState();
    io.emit("team-scores", teamScores);
    io.emit("individual-ranking", []);
  });

  socket.on("request-scores", () => {
    socket.emit("team-scores", teamScores);
  });

  socket.on("disconnect", () => {
    pendingInvitations.delete(socket.id);
    currentSongVotesChacal.delete(socket.data.participantId);
    participants.delete(socket.id);
    participantTeams.delete(socket.id);
    emitFullState();
  });
});

io.on("connection", (socket) => {
  socket.on("set-mode", (payload = {}) => {
    const mode = payload?.mode;
    if (!isHost(socket)) return;
    if (mode === "arcade" || mode === "teams") {
      gameMode = mode;
      io.emit("game-mode-changed", gameMode);
      emitFullState();
    }
  });
});

io.on("connection", (socket) => {
  const reply = (ack, value) => {
    if (typeof ack === "function") ack(value);
  };
  socket.on("support-performance", (payload = {}, ack) => {
    if (!socket.data.participantId)
      return reply(ack, {
        ok: false,
        message: "Entra al show antes de votar.",
      });
    const result = party.support(socket.data.participantId, payload?.songId);
    if (result.ok) emitFullState();
    reply(ack, result);
  });
  socket.on("set-lighting", (payload = {}, ack) => {
    if (!isHost(socket))
      return reply(ack, {
        ok: false,
        message: "Requiere acceso de anfitrión.",
      });
    if (
      !["off", "classic", "concert", "party"].includes(payload?.mode) ||
      !Number.isInteger(payload?.intensity) ||
      payload.intensity < 0 ||
      payload.intensity > 70
    )
      return reply(ack, { ok: false, message: "Iluminación no válida." });
    party.lighting = { mode: payload.mode, intensity: payload.intensity };
    emitFullState();
    reply(ack, { ok: true, message: "Iluminación actualizada." });
  });
  socket.on("create-challenge", (payload = {}, ack) => {
    const id = socket.data.participantId,
      target = [...io.sockets.sockets.values()].find(
        (s) => s.data.participantId === payload?.targetId,
      );
    if (!id || !target || id === payload.targetId)
      return reply(ack, {
        ok: false,
        message: "Elige otro participante conectado.",
      });
    if (
      !["duet", "duel", "surprise"].includes(payload.mode) ||
      typeof payload.genre !== "string" ||
      payload.genre.length > 40 ||
      !Array.isArray(payload.urls) ||
      payload.urls.length > 5
    )
      return reply(ack, {
        ok: false,
        message: "Revisa el modo, género y enlaces.",
      });
    const candidates = [
      ...new Set(payload.urls.map(parseVideo).filter(Boolean)),
    ];
    if (
      candidates.length !== payload.urls.length ||
      (payload.mode === "surprise"
        ? candidates.length < 2
        : candidates.length !== 1)
    )
      return reply(ack, {
        ok: false,
        message:
          "Usa enlaces distintos y válidos de YouTube. Sorpresa requiere al menos dos.",
      });
    party.closeDue();
    if (
      [...party.invitations.values()].some(
        (i) => i.fromId === id || i.targetId === payload.targetId,
      )
    )
      return reply(ack, {
        ok: false,
        message:
          "Ya hay una invitación pendiente. Espera su respuesta (máximo 2 minutos).",
      });
    if (party.duels.length >= 100 || queue.length >= 198)
      return reply(ack, {
        ok: false,
        message:
          "La sesión está llena. Finaliza algunos turnos antes de invitar.",
      });
    const invitation = {
      id: crypto.randomUUID(),
      fromId: id,
      targetId: payload.targetId,
      fromName: participants.get(socket.id),
      targetName: participants.get(target.id),
      mode: payload.mode,
      genre: payload.genre.trim(),
      candidates,
      expiresAt: Date.now() + 120000,
    };
    party.invitations.set(invitation.id, invitation);
    const { candidates: hidden, ...publicInvitation } = invitation;
    target.emit("challenge-invitation", publicInvitation);
    reply(ack, {
      ok: true,
      message:
        "Invitación enviada. La actuación entra a la cola solo si acepta.",
    });
  });
  socket.on("get-challenge-invitations", () => {
    party.closeDue();
    for (const i of party.invitations.values())
      if (i.targetId === socket.data.participantId) {
        const { candidates, ...publicInvitation } = i;
        socket.emit("challenge-invitation", publicInvitation);
      }
  });
  socket.on("respond-challenge", async (payload = {}, ack) => {
    const invitation = party.invitations.get(payload?.id);
    if (
      !invitation ||
      invitation.targetId !== socket.data.participantId ||
      Date.now() >= invitation.expiresAt
    )
      return reply(ack, {
        ok: false,
        message: "La invitación expiró. Pide una nueva.",
      });
    party.invitations.delete(invitation.id);
    const inviter = [...io.sockets.sockets.values()].find(
      (s) => s.data.participantId === invitation.fromId,
    );
    if (payload.accept !== true) {
      inviter?.emit(
        "notification",
        `${invitation.targetName} dejó el desafío para otra ocasión.`,
      );
      return reply(ack, { ok: true, message: "Invitación rechazada." });
    }
    if (!inviter)
      return reply(ack, {
        ok: false,
        message: "Quien te invitó se desconectó. Pide una nueva invitación.",
      });
    if (queue.length >= 198)
      return reply(ack, {
        ok: false,
        message: "La cola está llena. Inténtalo después.",
      });
    const videoId =
      invitation.candidates[crypto.randomInt(invitation.candidates.length)];
    const first = await makeSong(
      videoId,
      invitation.mode === "surprise"
        ? invitation.targetName
        : invitation.fromName,
      invitation.mode === "surprise" ? invitation.targetId : invitation.fromId,
    );
    if (queue.length >= 198)
      return reply(ack, {
        ok: false,
        message: "La cola se llenó mientras se preparaba la canción.",
      });
    if (invitation.mode === "duet") {
      first.kind = "duet";
      first.singerIds = [invitation.fromId, invitation.targetId];
      first.requester = `${invitation.fromName} + ${invitation.targetName}`;
      queue.push(first);
    } else if (invitation.mode === "duel") {
      const duel = {
        id: crypto.randomUUID(),
        singers: [invitation.fromId, invitation.targetId],
        names: [invitation.fromName, invitation.targetName],
        status: "queued",
        completed: [],
        eligible: [],
        votes: [],
      };
      party.duels.push(duel);
      first.kind = "duel";
      first.duelId = duel.id;
      const second = {
        ...first,
        id: crypto.randomUUID(),
        requesterId: invitation.targetId,
        requester: invitation.targetName,
      };
      queue.push(first, second);
    } else {
      first.kind = "surprise";
      queue.push(first);
    }
    if (!currentSong) nextSong();
    else emitFullState();
    const message = `Aceptado: ${first.title}. Revisa tu turno en la cola.`;
    socket.emit("challenge-accepted", { message });
    inviter.emit("challenge-accepted", { message });
    reply(ack, { ok: true, message });
  });
  socket.on("vote-duel", (payload = {}, ack) => {
    const result = party.voteDuel(
      socket.data.participantId,
      payload?.duelId,
      payload?.choice,
    );
    if (result.ok) emitFullState();
    reply(ack, result);
  });
  socket.on("close-duel-vote", (payload = {}, ack) => {
    if (!isHost(socket))
      return reply(ack, {
        ok: false,
        message: "Requiere acceso de anfitrión.",
      });
    const d = party.duels.find((d) => d.id === payload.id);
    if (!d || d.status !== "voting")
      return reply(ack, { ok: false, message: "No hay votación abierta." });
    d.deadline = Date.now();
    party.closeDue();
    emitFullState();
    reply(ack, { ok: true, message: "Votación cerrada." });
  });
  socket.on("export-session", (ack) => {
    if (!isHost(socket))
      return reply(ack, {
        ok: false,
        message: "Requiere acceso de anfitrión.",
      });
    reply(ack, { ok: true, data: snapshot() });
  });
  socket.on("import-session", (payload, ack) => {
    if (!isHost(socket))
      return reply(ack, {
        ok: false,
        message: "Requiere acceso de anfitrión.",
      });
    if (participants.size)
      return reply(ack, {
        ok: false,
        message:
          "Pide a los participantes que salgan antes de restaurar la copia.",
      });
    try {
      restore(payload);
      pendingInvitations.clear();
      stopDecay();
      currentSongClaps = 0;
      peakApplause = 0;
      emitFullState();
      reply(ack, {
        ok: true,
        message:
          "Sesión restaurada. Los participantes ya pueden volver a entrar.",
      });
    } catch (_) {
      reply(ack, {
        ok: false,
        message: "La copia no es válida o es de otra versión.",
      });
    }
  });
});

app.get("/config", async (req, res) => {
  try {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const participantUrl = `${protocol}://${host}/join.html`;
    const qrBase64 = await QRCode.toDataURL(participantUrl);
    res.json({ qrImage: qrBase64 });
  } catch (err) {
    console.error("Error al generar QR dinámico:", err);
    res.status(500).json({ error: "Error al generar QR" });
  }
});

if (require.main === module)
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🎤 Servidor Karaoke listo en: http://localhost:${PORT}`);
    console.log(
      `📱 Invitados: Acceso dinámico escaneando el código QR en la TV`,
    );
  });

module.exports = {
  server,
  io,
  stopTimers: () => {
    clearInterval(partyTimer);
    persist();
    stopDecay();
    clearTimeout(voiceEffectTimeout);
  },
};
