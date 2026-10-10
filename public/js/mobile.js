/* Participant UI. Socket.IO carries game state only; audio stays local. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const socket = io();
  const storage = {
    get() {
      try {
        return JSON.parse(
          sessionStorage.getItem("firevoice-session") || "null",
        );
      } catch (_) {
        return null;
      }
    },
    set(value) {
      try {
        sessionStorage.setItem("firevoice-session", JSON.stringify(value));
      } catch (_) {}
    },
    clear() {
      try {
        sessionStorage.removeItem("firevoice-session");
      } catch (_) {}
    },
  };
  let session = storage.get(),
    joined = false,
    activeSongId = null,
    receivedState = false;
  let canSing = false,
    totalClicks = 0,
    invitation = null,
    submitting = false,
    joinPending = false;
  let feedbackTimer,
    heard = false,
    outputVersion = 0;
  const statusNames = {
    idle: "Micrófono detenido",
    requesting: "Esperando permiso",
    ready: "Entrada preparada · salida silenciada",
    muted: "Salida silenciada",
    output: "Salida habilitada",
    interrupted: "Audio interrumpido",
    error: "No se pudo activar",
  };
  function notify(message) {
    $("feedback").textContent = message;
    $("feedback").hidden = false;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      $("feedback").hidden = true;
    }, 8000);
  }
  const audio = new LocalAudioEngine({
    onState({ state, message, muted }) {
      $("micStatus").textContent = statusNames[state];
      $("micMessage").textContent = message;
      const active = ["ready", "muted", "output", "interrupted"].includes(
        state,
      );
      $("audioControls").hidden = !active;
      $("micBtn").hidden = active;
      $("micBtn").disabled =
        state === "requesting" || !joined || !socket.connected;
      $("micBtn").textContent =
        state === "requesting" ? "Solicitando permiso…" : "Activar micrófono";
      $("cancelMicBtn").hidden = state !== "requesting";
      $("muteBtn").textContent = muted ? "Habilitar salida" : "Silenciar";
      $("muteBtn").classList.toggle("danger", !muted);
      $("heardBtn").disabled = state !== "output";
      if (state !== "output") {
        heard = false;
        ++outputVersion;
      }
      $("heardStatus").textContent = heard
        ? "Escucha confirmada por ti."
        : "Escucha pendiente de comprobar.";
    },
    onLevel({ rms, peak }) {
      $("inputLevel").value = Math.min(1, rms * 4);
      $("levelText").textContent = !audio.stream
        ? "Sin captura"
        : peak >= 0.95
          ? "Entrada saturada: aleja el teléfono o reduce el nivel."
          : rms > 0.005
            ? "Señal de entrada detectada"
            : "Entrada baja: habla cerca del micrófono.";
    },
  });
  $("micBtn").onclick = () => {
    if (joined && socket.connected) void audio.start();
  };
  $("stopMicBtn").onclick = () => void audio.stop();
  $("cancelMicBtn").onclick = () => void audio.stop();
  $("muteBtn").onclick = async () => {
    const version = ++outputVersion;
    heard = false;
    await audio.setMuted(!audio.muted);
    if (version !== outputVersion) return;
    $("heardStatus").textContent = "Escucha pendiente de comprobar.";
  };
  $("heardBtn").onclick = () => {
    if (audio.state !== "output") return;
    heard = true;
    $("heardStatus").textContent = "Escucha confirmada por ti.";
  };
  $("gainControl").oninput = (e) => {
    audio.setGain(e.target.value / 100);
    $("gainValue").value = `${e.target.value}%`;
    heard = false;
    $("heardStatus").textContent = "Nivel cambiado. Comprueba la escucha.";
  };
  $("voiceEffect").onchange = (e) => {
    audio.setEffect(e.target.value);
    if (canSing) socket.emit("trigger-voice-effect", e.target.value);
  };
  // Suspension, phone calls and background tabs must never resume an audible mic silently.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) void audio.stop();
  });
  window.addEventListener("pagehide", () => void audio.stop());
  function chooseTab(tabId) {
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.hidden = panel.id !== tabId;
    });
    document.querySelectorAll("[data-tab]").forEach((button) => {
      if (button.dataset.tab === tabId)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  }
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.onclick = () => chooseTab(button.dataset.tab);
  });
  function enterSession() {
    if (!session || !socket.connected) return;
    joinPending = true;
    $("enterBtn").disabled = true;
    socket.emit("join-team", {
      nickname: session.nickname,
      team: session.team,
      sessionToken: session.sessionToken,
    });
  }
  socket.on("connect", () => {
    $("connectionStatus").textContent = "Conectado";
    if (session) enterSession();
    socket.emit("get-state");
  });
  socket.on("disconnect", () => {
    joined = false;
    joinPending = false;
    $("connectionStatus").textContent = "Sin conexión";
    $("enterBtn").disabled = false;
    $("micBtn").disabled = true;
    void audio.stop();
    notify(
      "Se perdió la conexión. El micrófono se detuvo; vuelve a activarlo cuando reconecte.",
    );
  });
  socket.on("connect_error", () => {
    $("connectionStatus").textContent = "Reconectando…";
  });
  socket.on("error-msg", notify);
  $("joinForm").onsubmit = (e) => {
    e.preventDefault();
    if (joinPending) return;
    if (!socket.connected)
      return notify("Espera a que se restablezca la conexión.");
    session = {
      nickname: $("nicknameInput").value.trim(),
      team: document.querySelector("input[name=team]:checked").value,
    };
    if (!session.nickname) return;
    enterSession();
  };
  socket.on("nickname-set", (data) => {
    joined = true;
    joinPending = false;
    session = data;
    storage.set(data);
    $("loginSection").hidden = true;
    $("mainSection").hidden = false;
    $("enterBtn").disabled = false;
    $("micBtn").disabled = false;
    $("userTeamBadge").textContent =
      `${data.nickname} · ${data.team === "red" ? "🔴 Rojo" : "🔵 Azul"}`;
    socket.emit("get-state");
    socket.emit("get-challenge-invitations");
  });
  $("leaveBtn").onclick = async () => {
    await audio.stop();
    session = null;
    joined = false;
    storage.clear();
    socket.disconnect();
    socket.connect();
    $("mainSection").hidden = true;
    $("loginSection").hidden = false;
    $("inviteDialog").close();
    $("receiveDialog").close();
    $("challengeDialog").close();
    challengeInvitation = null;
    invitation = null;
    totalClicks = 0;
    updateEnergy();
  };
  function updateEnergy() {
    $("energyText").textContent =
      `${Math.max(0, 1000 - totalClicks)} reacciones disponibles`;
    $("clapBtn").disabled = $("screamBtn").disabled = totalClicks >= 1000;
  }
  function react(type) {
    if (!joined || !socket.connected)
      return notify("Conéctate al show para reaccionar.");
    if (totalClicks >= 1000) return;
    socket.emit("submit-claps", {
      claps: type === "claps" ? 1 : 0,
      screams: type === "screams" ? 1 : 0,
    });
    totalClicks++;
    updateEnergy();
  }
  $("clapBtn").onclick = () => react("claps");
  $("screamBtn").onclick = () => react("screams");
  $("chacalBtn").onclick = () => {
    if (!socket.connected) return notify("Sin conexión al show.");
    socket
      .timeout(5000)
      .emit("vote-chacal", (error, result) =>
        notify(
          error
            ? "No se confirmó la llamada."
            : result?.message || "Llamada recibida.",
        ),
      );
  };
  document.querySelectorAll("[data-effect]").forEach((button) => {
    button.onclick = () => {
      if (socket.connected)
        socket.emit("trigger-effect", button.dataset.effect);
    };
  });

  function songFeedback(message) {
    $("songFeedback").textContent = message;
  }
  $("songForm").onsubmit = (e) => {
    e.preventDefault();
    if (submitting) return;
    if (!socket.connected || !joined)
      return songFeedback("Conéctate antes de añadir una canción.");
    let url = $("youtubeUrlInput").value.trim();
    if (!url)
      return songFeedback(
        "Pega un enlace de YouTube antes de añadir la canción.",
      );
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    try {
      const parsed = new URL(url);
      if (
        ![
          "youtube.com",
          "www.youtube.com",
          "m.youtube.com",
          "music.youtube.com",
          "youtu.be",
          "www.youtu.be",
        ].includes(parsed.hostname) ||
        !["https:", "http:"].includes(parsed.protocol)
      )
        throw new Error();
    } catch (_) {
      return songFeedback(
        "El enlace debe ser de YouTube. Usa Compartir → Copiar enlace en el video.",
      );
    }
    songFeedback("Enviando canción…");
    submitting = true;
    $("addSongBtn").disabled = true;
    $("addSongBtn").textContent = "Añadiendo…";
    socket.timeout(12000).emit("add-song", { url }, (error, result) => {
      submitting = false;
      $("addSongBtn").disabled = false;
      $("addSongBtn").textContent = "Añadir a la cola";
      if (error)
        return songFeedback(
          "No pudimos confirmar la solicitud. Revisa la cola antes de volver a enviarla.",
        );
      if (!result)
        return songFeedback(
          "El servidor no confirmó la solicitud. Inténtalo otra vez.",
        );
      songFeedback(result.message);
      if (result.ok) $("youtubeUrlInput").value = "";
    });
  };
  socket.on("state-update", (data) => {
    $("chacalHint").textContent =
      data.chacalMode === "competencia"
        ? "Modo Competencia: con 50 % de votos, el Chacal pausa la canción hasta 5 segundos."
        : "Modo Fiesta: el Chacal anima sin interrumpir.";
    $("booBtn").hidden = !data.allowBoo;
    updateParty(data);
    const newId = data.currentSong?.id || null;
    if (receivedState && newId !== activeSongId) {
      void audio.stop();
      totalClicks = 0;
      updateEnergy();
      $("voiceEffect").value = "normal";
      audio.setEffect("normal");
      $("receiveDialog").close();
      $("inviteDialog").close();
      invitation = null;
    }
    receivedState = true;
    activeSongId = newId;
    canSing = Boolean(
      session &&
      data.currentSong &&
      (data.currentSong.requesterId === session.participantId ||
        data.coSingerIds?.includes(session.participantId)),
    );
    $("inviteBtn").hidden =
      !canSing ||
      Boolean(data.currentSong?.duelId) ||
      data.currentSong?.kind === "duet";
    $("currentSongTitle").textContent =
      data.currentSong?.title || "Todavía no hay canciones";
    $("turnLabel").textContent = canSing
      ? "ES TU MOMENTO"
      : data.currentSong
        ? "AHORA EN EL ESCENARIO"
        : "ESPERANDO EL SHOW";
    const ownIndex = (data.queue || []).findIndex(
      (song) => song.requesterId === session?.participantId,
    );
    $("turnDescription").textContent = canSing
      ? "Activa tu micrófono y comprueba la salida antes de cantar."
      : ownIndex >= 0
        ? `Tu próximo turno está en la posición ${ownIndex + 1} de la cola.`
        : data.currentSong
          ? `Canta ${data.currentSong.requester}. Puedes probar tu micrófono mientras esperas.`
          : "Añade una canción para entrar en la cola.";
    $("scoreboard").hidden = data.gameMode === "arcade";
    if (data.teamScores) updateScores(data.teamScores);
    const list = $("songQueue");
    list.replaceChildren();
    if (!data.queue?.length) {
      const item = document.createElement("li");
      item.textContent = "La cola está vacía.";
      list.append(item);
    } else
      data.queue.forEach((song) => {
        const item = document.createElement("li");
        item.textContent = song.title;
        const caption = document.createElement("small");
        caption.textContent = `${song.requester}${song.kind && song.kind !== "solo" ? " · " + ({ duet: "Dueto", duel: "Duelo", surprise: "Sorpresa" }[song.kind] || "") : ""}`;
        item.append(caption);
        list.append(item);
      });
    const effect = canSing ? data.activeVoiceEffect || "normal" : audio.effect;
    audio.setEffect(effect);
    $("voiceEffect").value = audio.effect;
  });
  function updateScores(scores) {
    $("redPoints").textContent = scores.red || 0;
    $("bluePoints").textContent = scores.blue || 0;
  }
  socket.on("team-scores", updateScores);
  socket.on("voice-effect-changed", ({ effect }) => {
    if (!canSing) return;
    audio.setEffect(effect);
    $("voiceEffect").value = audio.effect;
  });
  $("inviteBtn").onclick = () => socket.emit("get-participants");
  socket.on("participants-list", (list) => {
    $("inviteList").replaceChildren();
    list
      .filter((person) => person.id !== socket.id)
      .forEach((person) => {
        const button = document.createElement("button");
        button.textContent = person.name;
        button.onclick = () => {
          socket.emit("invite-participant", { targetSocketId: person.id });
          $("inviteDialog").close();
          notify("Invitación enviada.");
        };
        $("inviteList").append(button);
      });
    if (!$("inviteList").children.length)
      $("inviteList").textContent = "No hay otros participantes conectados.";
    if (!$("inviteDialog").open) $("inviteDialog").showModal();
  });
  $("closeInviteBtn").onclick = () => $("inviteDialog").close();
  socket.on("receive-invitation", (data) => {
    invitation = data;
    $("invitationText").textContent =
      `${data.fromName} te invita a cantar esta canción.`;
    if (!$("receiveDialog").open) $("receiveDialog").showModal();
  });
  $("acceptInviteBtn").onclick = () => {
    if (invitation) socket.emit("accept-invitation", invitation.fromId);
    $("receiveDialog").close();
    invitation = null;
  };
  $("rejectInviteBtn").onclick = () => {
    $("receiveDialog").close();
    invitation = null;
  };
  socket.on("invitation-accepted", () => {
    chooseTab("sing");
    notify(
      "Dúo aceptado. Cada cantante activa su micrófono en su propio celular.",
    );
  });
  $("stickerForm").onsubmit = async (e) => {
    e.preventDefault();
    const container = $("giphyResults");
    container.textContent = "Buscando…";
    try {
      const response = await fetch(
        `/api/giphy?q=${encodeURIComponent($("giphySearch").value || "party")}`,
      );
      if (!response.ok) throw new Error("search");
      const data = await response.json();
      container.replaceChildren();
      (data.data || []).forEach((sticker) => {
        const button = document.createElement("button");
        button.setAttribute(
          "aria-label",
          `Enviar sticker: ${sticker.title || "animación"}`,
        );
        const img = document.createElement("img");
        img.src = sticker.images.fixed_height.url;
        img.alt = "";
        img.loading = "lazy";
        button.append(img);
        button.onclick = () => socket.emit("send-sticker", img.src);
        container.append(button);
      });
      if (!container.children.length)
        container.textContent = "No encontramos stickers con esa búsqueda.";
    } catch (_) {
      container.textContent = "No se pudo buscar. Vuelve a intentarlo.";
    }
  };

  let partyState = {},
    challengeInvitation = null,
    sendingChallenge = false,
    replyingChallenge = false;
  function call(event, payload, done) {
    if (!joined || !socket.connected) {
      done({ ok: false, message: "Conéctate al show antes de continuar." });
      return;
    }
    socket.timeout(12000).emit(event, payload, (error, result) => {
      const reply = error
        ? {
            ok: false,
            message:
              "No se confirmó la solicitud. Revisa el estado antes de repetir.",
          }
        : result || { ok: false, message: "Sin respuesta del servidor." };
      done(reply);
    });
  }
  function renderRanking(container, rows) {
    container.replaceChildren();
    if (!rows?.length) {
      container.textContent =
        "Completa una actuación con público para aparecer aquí.";
      return;
    }
    rows.slice(0, 10).forEach((row, index) => {
      const el = document.createElement("div");
      el.className = "ranking-row";
      const name = document.createElement("strong");
      name.textContent = `${index + 1}. ${row.name}`;
      const score = document.createElement("span");
      score.textContent = `${row.score}%`;
      const note = document.createElement("small");
      note.textContent = row.provisional
        ? `Provisional · ${row.performances}/2 actuaciones`
        : `${row.performances} actuaciones`;
      el.append(name, score, note);
      container.append(el);
    });
  }
  function updateDuel() {
    const duel =
      (partyState.duels || []).find((d) => d.status === "voting") ||
      (partyState.duels || []).at(-1);
    $("mobileDuelCard").hidden = !duel;
    if (!duel) return;
    $("mobileDuelTitle").textContent = duel.names.join(" vs. ");
    const canVote =
      joined &&
      socket.connected &&
      duel.status === "voting" &&
      Date.now() < duel.deadline &&
      duel.eligible.includes(session?.participantId) &&
      !duel.voted.includes(session?.participantId);
    const labels = {
      queued: "Dos actuaciones reservadas en la cola.",
      performing: "Se vota cuando terminen ambas actuaciones.",
      cancelled: "Duelo cancelado: se omitió una actuación.",
    };
    $("mobileDuelStatus").textContent =
      duel.status === "voting"
        ? `Votación: ${Math.max(0, Math.ceil((duel.deadline - Date.now()) / 1000))} s · ${duel.total} votos${duel.voted.includes(session?.participantId) ? " · Tu voto está registrado" : ""}`
        : duel.status === "closed"
          ? duel.total
            ? `${duel.names[0]} ${duel.percentages[0]}% · ${duel.names[1]} ${duel.percentages[1]}% · ${duel.total} votos${duel.counts[0] === duel.counts[1] ? " · Empate" : ""}`
            : "Sin votos: no hay ganador."
          : labels[duel.status] || "";
    $("duelVoteButtons").replaceChildren();
    if (duel.status === "voting")
      duel.names.forEach((name, index) => {
        const button = document.createElement("button");
        button.className = "primary";
        button.textContent = name;
        button.disabled = !canVote;
        button.onclick = () =>
          call(
            "vote-duel",
            { duelId: duel.id, choice: duel.singers[index] },
            (result) => notify(result.message),
          );
        $("duelVoteButtons").append(button);
      });
  }
  function updateParty(data) {
    partyState = data;
    const support = data.support,
      id = session?.participantId;
    const voted = support?.votes.includes(id),
      eligible = support?.eligible.includes(id);
    $("supportBtn").disabled =
      !joined ||
      !socket.connected ||
      !eligible ||
      Boolean(data.currentSong?.duelId) ||
      voted;
    $("supportBtn").textContent = voted
      ? "Apoyo registrado ✓"
      : "Apoyar esta actuación";
    $("supportStatus").textContent = !data.currentSong
      ? "Esperando actuación."
      : data.currentSong.duelId
        ? "En el duelo se vota al terminar ambas actuaciones."
        : voted
          ? "Gracias por apoyar. No puedes repetir el voto."
          : eligible
            ? "Tu voto cuenta una vez. Puedes seguir aplaudiendo."
            : "Disfruta tu actuación: los cantantes no pueden votarse.";
    renderRanking($("mobileRanking"), data.ranking);
    renderRanking($("mobileDuetRanking"), data.duetRanking);
    const select = $("challengeTarget"),
      previous = select.value;
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Elige un participante";
    select.append(placeholder);
    (data.participantList || [])
      .filter((p) => p.id && p.id !== id)
      .forEach((p) => {
        const option = document.createElement("option");
        option.value = p.id;
        option.textContent = p.name;
        select.append(option);
      });
    select.value = previous;
    updateDuel();
  }
  $("supportBtn").onclick = () =>
    call(
      "support-performance",
      { songId: partyState.currentSong?.id },
      (result) => {
        $("supportStatus").textContent = result.message;
      },
    );
  $("challengeForm").onsubmit = (e) => {
    e.preventDefault();
    if (sendingChallenge) return;
    if (!joined || !socket.connected) {
      $("challengeFeedback").textContent = "Conéctate antes de invitar.";
      return;
    }
    const urls = $("challengeUrls")
      .value.split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);
    const mode = $("challengeMode").value;
    if (!$("challengeTarget").value) {
      $("challengeFeedback").textContent = "Elige otro participante conectado.";
      return;
    }
    if (
      (mode === "surprise" && (urls.length < 2 || urls.length > 5)) ||
      (mode !== "surprise" && urls.length !== 1)
    ) {
      $("challengeFeedback").textContent =
        "Dueto y duelo requieren un enlace. Sorpresa requiere de 2 a 5 enlaces distintos.";
      return;
    }
    sendingChallenge = true;
    $("sendChallengeBtn").disabled = true;
    $("challengeFeedback").textContent = "Enviando invitación…";
    call(
      "create-challenge",
      {
        targetId: $("challengeTarget").value,
        mode,
        genre: $("challengeGenre").value.trim(),
        urls,
      },
      (result) => {
        sendingChallenge = false;
        $("sendChallengeBtn").disabled = false;
        $("challengeFeedback").textContent = result.message;
      },
    );
  };
  socket.on("challenge-invitation", (data) => {
    if (data.expiresAt <= Date.now()) return;
    challengeInvitation = data;
    $("challengeDialogStatus").textContent = "";
    const labels = {
      duet: "un dueto",
      duel: "un duelo de la misma canción",
      surprise: "un desafío sorpresa",
    };
    $("challengeDialogTitle").textContent =
      data.mode === "surprise" ? "Desafío sorpresa" : "Comparte el escenario";
    $("challengeInvitationText").textContent =
      `${data.fromName} te invita a ${labels[data.mode]}. ${data.genre ? "Tema: " + data.genre + ". " : ""}${data.mode === "surprise" ? "La canción se revela al aceptar. " : ""}Tienes dos minutos para responder.`;
    if (!$("challengeDialog").open) $("challengeDialog").showModal();
  });
  function respondChallenge(accept) {
    if (!challengeInvitation || replyingChallenge) return;
    replyingChallenge = true;
    $("acceptChallengeBtn").disabled = $("rejectChallengeBtn").disabled = true;
    $("challengeDialogStatus").textContent = accept
      ? "Preparando actuación…"
      : "Enviando respuesta…";
    call(
      "respond-challenge",
      { id: challengeInvitation.id, accept },
      (result) => {
        replyingChallenge = false;
        $("acceptChallengeBtn").disabled = $("rejectChallengeBtn").disabled =
          false;
        if (result.ok) {
          $("challengeDialog").close();
          challengeInvitation = null;
          notify(result.message);
          if (accept) chooseTab("songs");
        } else $("challengeDialogStatus").textContent = result.message;
      },
    );
  }
  $("acceptChallengeBtn").onclick = () => respondChallenge(true);
  $("rejectChallengeBtn").onclick = () => respondChallenge(false);
  $("challengeDialog").addEventListener("cancel", (e) => {
    e.preventDefault();
    respondChallenge(false);
  });
  socket.on("challenge-accepted", (data) => notify(data.message));
  socket.on("notification", notify);
  socket.on("disconnect", () => {
    $("supportBtn").disabled = true;
    updateDuel();
  });
  const partyClock = setInterval(() => {
    updateDuel();
    if (
      challengeInvitation &&
      challengeInvitation.expiresAt <= Date.now() &&
      !replyingChallenge
    ) {
      $("challengeDialog").close();
      challengeInvitation = null;
      notify("La invitación expiró. Puedes pedir una nueva.");
    }
  }, 1000);
  window.addEventListener("pagehide", () => clearInterval(partyClock));
})();
