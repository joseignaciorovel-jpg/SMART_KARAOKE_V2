"use strict";
const fs = require("node:fs");
const path = require("node:path");
class SessionStore {
  constructor(directory) {
    this.directory = directory || null;
    this.error = null;
    this.savedAt = null;
  }
  read() {
    if (!this.directory) return null;
    const file = path.join(this.directory, "session.json");
    if (!fs.existsSync(file)) return null;
    // Corrupt data must stop startup; overwriting the only copy would lose the party.
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    validateSnapshot(data);
    this.savedAt = data.savedAt;
    return data;
  }
  write(data) {
    if (!this.directory) return false;
    try {
      validateSnapshot(data);
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, "session.json"),
        temporary = file + ".tmp";
      const fd = fs.openSync(temporary, "w", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(data));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (fs.existsSync(file)) fs.copyFileSync(file, file + ".previous");
      fs.renameSync(temporary, file);
      this.savedAt = data.savedAt;
      this.error = null;
      return true;
    } catch (error) {
      this.error = "No se pudo guardar la sesión.";
      console.error("Session storage:", error.message);
      return false;
    }
  }
}
function validateSnapshot(data) {
  if (
    !data ||
    data.version !== 1 ||
    typeof data.savedAt !== "number" ||
    !Array.isArray(data.queue) ||
    data.queue.length > 200 ||
    !Array.isArray(data.history) ||
    data.history.length > 20 ||
    !Array.isArray(data.sessions) ||
    data.sessions.length > 500 ||
    !data.party ||
    !Array.isArray(data.party.performances) ||
    data.party.performances.length > 500 ||
    !Array.isArray(data.party.duels) ||
    data.party.duels.length > 100
  )
    throw new Error("Copia de sesión no válida.");
  const text = (v, max = 100) => typeof v === "string" && v.length <= max;
  for (const session of data.sessions)
    if (
      !text(session.id) ||
      !text(session.token, 64) ||
      !/^[a-f0-9]{64}$/.test(session.token) ||
      !text(session.nickname, 40) ||
      ![null, "red", "blue"].includes(session.team)
    )
      throw new Error("Participante no válido.");
  const song = (s) =>
    s &&
    text(s.id) &&
    text(s.requesterId) &&
    text(s.requester, 100) &&
    text(s.title, 500) &&
    /^[\w-]{11}$/.test(s.videoId) &&
    (!s.singerIds ||
      (Array.isArray(s.singerIds) &&
        s.singerIds.length <= 2 &&
        s.singerIds.every((id) => text(id))));
  if (
    ![
      ...data.queue,
      ...data.history,
      ...(data.currentSong ? [data.currentSong] : []),
    ].every(song)
  )
    throw new Error("Canción no válida.");
  for (const p of data.party.performances)
    if (
      !Array.isArray(p.singers) ||
      p.singers.length > 2 ||
      !p.singers.every((id) => text(id)) ||
      !text(p.name, 100) ||
      !["solo", "duet"].includes(p.kind) ||
      !Number.isFinite(p.score) ||
      p.score < 0 ||
      p.score > 100
    )
      throw new Error("Ranking no válido.");
  const a = data.party.active;
  if (
    a &&
    (!text(a.songId) ||
      !Array.isArray(a.singers) ||
      a.singers.length > 2 ||
      !Array.isArray(a.eligible) ||
      !Array.isArray(a.votes) ||
      a.eligible.length > 500 ||
      a.votes.length > 500 ||
      ![...a.singers, ...a.eligible, ...a.votes].every((id) => text(id)) ||
      a.votes.some((id) => !a.eligible.includes(id)))
  )
    throw new Error("Actuación no válida.");
  for (const d of data.party.duels)
    if (
      !text(d.id) ||
      !Array.isArray(d.singers) ||
      d.singers.length !== 2 ||
      !d.singers.every((id) => text(id)) ||
      !Array.isArray(d.names) ||
      d.names.length !== 2 ||
      !d.names.every((n) => text(n, 40)) ||
      !["queued", "performing", "voting", "closed", "cancelled"].includes(
        d.status,
      ) ||
      !Array.isArray(d.completed) ||
      d.completed.length > 2 ||
      !Array.isArray(d.votes) ||
      d.votes.length > 500 ||
      !Array.isArray(d.eligible) ||
      d.eligible.length > 500 ||
      !d.eligible.every((id) => text(id)) ||
      !d.votes.every((v) => text(v.id) && d.singers.includes(v.choice)) ||
      (d.status === "voting" && !Number.isFinite(d.deadline))
    )
      throw new Error("Duelo no válido.");
  if (
    !["off", "classic", "concert", "party"].includes(
      data.party.lighting?.mode,
    ) ||
    !Number.isFinite(data.party.lighting.intensity) ||
    data.party.lighting.intensity < 0 ||
    data.party.lighting.intensity > 70
  )
    throw new Error("Iluminación no válida.");
  if (
    !["teams", "arcade"].includes(data.gameMode) ||
    !["fiesta", "competencia"].includes(data.chacalMode) ||
    typeof data.allowBoo !== "boolean" ||
    !Number.isFinite(data.teamScores?.red) ||
    !Number.isFinite(data.teamScores?.blue)
  )
    throw new Error("Opciones no válidas.");
  if (JSON.stringify(data).length > 500000)
    throw new Error("Copia demasiado grande.");
  return data;
}
module.exports = { SessionStore, validateSnapshot };
