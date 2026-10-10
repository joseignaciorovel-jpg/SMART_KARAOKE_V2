"use strict";
const crypto = require("node:crypto");
const MIN_PERFORMANCES = 2;
class Party {
  constructor(saved = {}) {
    this.performances = saved.performances || [];
    this.active = saved.active || null;
    this.duels = saved.duels || [];
    this.lighting = saved.lighting || { mode: "concert", intensity: 35 };
    this.invitations = new Map(); // Short-lived invitations deliberately expire on a restart.
  }
  start(song, audience) {
    if (!song) {
      this.active = null;
      return;
    }
    const singers = song.singerIds || [song.requesterId];
    this.active = {
      songId: song.id,
      singers,
      name: song.requester,
      kind: song.kind || "solo",
      duelId: song.duelId || null,
      eligible: [],
      votes: [],
      startedAt: Date.now(),
    };
    this.addAudience(audience);
    const duel = this.duels.find((d) => d.id === song.duelId);
    if (duel && !["cancelled", "closed"].includes(duel.status))
      duel.status = "performing";
  }
  addAudience(ids) {
    if (!this.active) return;
    for (const id of ids)
      if (
        !this.active.singers.includes(id) &&
        !this.active.eligible.includes(id)
      )
        this.active.eligible.push(id);
  }
  support(id, songId) {
    const a = this.active;
    if (!a || a.songId !== songId)
      return {
        ok: false,
        message: "La actuación cambió. Actualiza antes de votar.",
      };
    if (a.duelId) return {ok:false,message:"En un duelo, vota al terminar ambas actuaciones."};
    if (!a.eligible.includes(id))
      return {
        ok: false,
        message: "Los cantantes no pueden votarse a sí mismos.",
      };
    if (a.votes.includes(id))
      return { ok: false, message: "Ya apoyaste esta actuación." };
    a.votes.push(id);
    return { ok: true, message: "Apoyo registrado: un voto por actuación." };
  }
  finish(song, completed, audience) {
    const a = this.active;
    this.active = null;
    if (!song || !a || a.songId !== song.id) return;
    if (song.duelId) {
      const duel = this.duels.find((d) => d.id === song.duelId);
      if (!duel || ["closed", "cancelled"].includes(duel.status)) return;
      if (!completed) {
        duel.status = "cancelled";
        return;
      }
      if (!duel.completed.includes(song.id)) duel.completed.push(song.id);
      if (duel.completed.length === 2) {
        duel.status = "voting";
        duel.deadline = Date.now() + 30000;
        duel.eligible = [...new Set(audience)].filter(
          (id) => !duel.singers.includes(id),
        );
      }
    } else if (completed && a.eligible.length) {
      this.performances.push({
        id: crypto.randomUUID(),
        songId: song.id,
        singers: a.singers,
        name: song.requester,
        kind: a.kind === "duet" ? "duet" : "solo",
        support: a.votes.length,
        voters: a.eligible.length,
        score: Math.round((100 * a.votes.length) / a.eligible.length),
        endedAt: Date.now(),
      });
      if (this.performances.length > 500) this.performances.shift();
    }
  }
  cancel(song) {
    const duel = this.duels.find((d) => d.id === song?.duelId);
    if (duel && !["closed", "cancelled"].includes(duel.status))
      duel.status = "cancelled";
  }
  voteDuel(id, duelId, choice) {
    const d = this.duels.find((d) => d.id === duelId);
    if (!d || d.status !== "voting" || Date.now() >= d.deadline)
      return { ok: false, message: "La votación del duelo ya terminó." };
    if (!d.eligible.includes(id) || !d.singers.includes(choice))
      return {
        ok: false,
        message: "Solo el público de esta ronda puede votar. Sin voto propio.",
      };
    if (d.votes.some((v) => v.id === id))
      return { ok: false, message: "Ya votaste en este duelo." };
    d.votes.push({ id, choice });
    return { ok: true, message: "Voto del duelo registrado." };
  }
  closeDue(now = Date.now()) {
    let changed = false;
    for (const d of this.duels)
      if (d.status === "voting" && now >= d.deadline) {
        d.status = "closed";
        changed = true;
      }
    for (const [id, invitation] of this.invitations)
      if (now >= invitation.expiresAt) this.invitations.delete(id);
    return changed;
  }
  ranking(kind = "solo") {
    const groups = new Map();
    for (const p of this.performances.filter((p) => p.kind === kind)) {
      const id = [...p.singers].sort().join(":");
      const row = groups.get(id) || {
        id,
        name: p.name,
        total: 0,
        performances: 0,
      };
      row.total += p.score;
      row.performances++;
      row.name = p.name;
      groups.set(id, row);
    }
    return [...groups.values()]
      .map((r) => ({
        id: r.id,
        name: r.name,
        score: Math.round(r.total / r.performances),
        performances: r.performances,
        provisional: r.performances < MIN_PERFORMANCES,
      }))
      .sort(
        (a, b) =>
          Number(a.provisional) - Number(b.provisional) ||
          b.score - a.score ||
          b.performances - a.performances ||
          a.name.localeCompare(b.name),
      );
  }
  publicDuels() {
    return this.duels.slice(-20).map((d) => {
      const counts = d.singers.map(
          (id) => d.votes.filter((v) => v.choice === id).length,
        ),
        total = counts.reduce((a, b) => a + b, 0);
      return {
        id: d.id,
        names: d.names,
        singers: d.singers,
        status: d.status,
        deadline: d.deadline || null,
        eligible: d.eligible || [],
        voted: d.votes.map((v) => v.id),
        total,
        counts: d.status === "closed" ? counts : null,
        percentages:
          d.status === "closed"
            ? counts.map((n) => (total ? Math.round((100 * n) / total) : 0))
            : null,
      };
    });
  }
  snapshot() {
    return {
      performances: this.performances,
      active: this.active,
      duels: this.duels,
      lighting: this.lighting,
    };
  }
}
module.exports = { Party, MIN_PERFORMANCES };
