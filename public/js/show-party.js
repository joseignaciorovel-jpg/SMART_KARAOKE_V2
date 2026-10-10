/* Show features use the authenticated host session established by index.html. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const { socket, getIsHost } = window.firevoiceShow;
  let latestState = {},
    duel = null;
  function rows(container, ranking) {
    container.replaceChildren();
    if (!ranking?.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent =
        "El ranking comienza al finalizar una actuación con público.";
      container.append(p);
      return;
    }
    ranking.slice(0, 3).forEach((r, index) => {
      const row = document.createElement("div");
      row.className = "ranking-row";
      const name = document.createElement("strong");
      name.textContent = `${index + 1}. ${r.name}`;
      const score = document.createElement("span");
      score.textContent = `${r.score}%`;
      const note = document.createElement("small");
      note.textContent = r.provisional
        ? `Provisional · ${r.performances}/2 actuaciones`
        : `${r.performances} actuaciones`;
      row.append(name, score, note);
      container.append(row);
    });
  }
  function lights(options = { mode: "concert", intensity: 35 }) {
    document.body.dataset.lighting = options.mode;
    document.body.style.setProperty(
      "--light-strength",
      String(options.intensity / 100),
    );
    $("lightingMode").value = options.mode;
    $("lightingIntensity").value = options.intensity;
    $("lightingValue").value = `${options.intensity} %`;
  }
  function refreshDuel() {
    if (!duel) {
      $("duelCard").hidden = true;
      return;
    }
    $("duelCard").hidden = false;
    $("duelTitle").textContent = duel.names.join(" vs. ");
    const labels = {
      queued: "Dos turnos reservados en la cola.",
      performing: "Actuaciones en curso · se vota al terminar ambas.",
      cancelled: "Duelo cancelado: se omitió una actuación.",
    };
    $("duelStatus").textContent =
      duel.status === "voting"
        ? `El público vota · ${Math.max(0, Math.ceil((duel.deadline - Date.now()) / 1000))} s · ${duel.total} votos`
        : duel.status === "closed"
          ? `${duel.total} votos válidos · ${duel.total ? "Favorito del público" : "Sin votos: no hay ganador"}`
          : labels[duel.status] || "";
    $("duelResult").replaceChildren();
    if (duel.status === "closed" && duel.total) {
      duel.names.forEach((name, index) => {
        const p = document.createElement("p");
        p.className = "duel-result-row";
        p.textContent = `${name} · ${duel.percentages[index]}%`;
        $("duelResult").append(p);
      });
      if (duel.counts[0] === duel.counts[1])
        $("duelStatus").textContent += " · Empate";
    }
    $("closeDuelBtn").hidden = !getIsHost() || duel.status !== "voting";
  }
  socket.on("state-update", (state) => {
    latestState = state;
    lights(state.lighting);
    rows($("liveRanking"), state.ranking);
    const p = state.persistence;
    $("persistenceStatus").textContent =
      p?.error ||
      (p?.configured
        ? "Guardado automático activo · conserva sesión, cola y resultados."
        : "Guardado automático pendiente de activar. Descarga una copia antes de cerrar la fiesta o reiniciar el servidor.");
    duel =
      (state.duels || []).find((d) => d.status === "voting") ||
      (state.duels || []).at(-1) ||
      null;
    refreshDuel();
  });
  socket.on("individual-ranking", (ranking) => rows($("liveRanking"), ranking));
  socket.on("show-final-ranking", (data) => {
    const container = $("duetPodium");
    container.replaceChildren();
    if (data.duets?.length) {
      const heading = document.createElement("h2");
      heading.textContent = "Duetos · Favoritos del público";
      container.append(heading);
      rows(container.appendChild(document.createElement("div")), data.duets);
    }
  });
  socket.on("disconnect", () => {
    $("closeDuelBtn").hidden = true;
  });
  $("showRankingBtn").onclick = () => {
    if (getIsHost()) socket.emit("request-final-ranking");
    else {
      $("displayFeedback").textContent =
        "El anfitrión puede abrir el podio desde esta pantalla.";
      $("displayFeedback").hidden = false;
    }
  };
  const setLighting = () => {
    if (!getIsHost()) return;
    socket
      .timeout(5000)
      .emit(
        "set-lighting",
        {
          mode: $("lightingMode").value,
          intensity: Number($("lightingIntensity").value),
        },
        (error, result) => {
          if (error || !result?.ok) {
            $("hostStatus").textContent =
              result?.message || "No se confirmó el cambio de iluminación.";
            lights(latestState.lighting);
          }
        },
      );
  };
  $("lightingMode").onchange = setLighting;
  $("lightingIntensity").oninput = () => {
    $("lightingValue").value = `${$("lightingIntensity").value} %`;
  };
  $("lightingIntensity").onchange = setLighting;
  $("finishSongBtn").onclick = () => {
    if (getIsHost() && latestState.currentSong)
      socket.emit("finish-song", { songId: latestState.currentSong.id });
  };
  $("closeDuelBtn").onclick = () => {
    if (duel && getIsHost()) socket.emit("close-duel-vote", { id: duel.id });
  };
  $("backupBtn").onclick = () => {
    socket.timeout(5000).emit("export-session", (error, result) => {
      if (error || !result?.ok) {
        $("backupStatus").textContent =
          result?.message || "No se pudo descargar la copia.";
        return;
      }
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result.data, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `firevoice-sesion-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      $("backupStatus").textContent =
        "Copia descargada. Guárdala de forma privada.";
    });
  };
  $("restoreFile").onchange = async () => {
    const file = $("restoreFile").files[0];
    if (!file) return;
    try {
      if (file.size > 500000) throw new Error("Copia demasiado grande.");
      const data = JSON.parse(await file.text());
      if (
        !confirm(
          "¿Reemplazar la sesión con esta copia? Los participantes deben haber salido.",
        )
      )
        return;
      socket.timeout(5000).emit("import-session", data, (error, result) => {
        $("backupStatus").textContent = error
          ? "No se confirmó la restauración."
          : result?.message || "Sin respuesta.";
      });
    } catch (_) {
      $("backupStatus").textContent =
        "Selecciona una copia JSON válida de FireVoice (máximo 500 KB).";
    } finally {
      $("restoreFile").value = "";
    }
  };
  // Low-frequency clock for the voting window; no audio or microphone capture.
  const clock = setInterval(refreshDuel, 1000);
  window.addEventListener("pagehide", () => clearInterval(clock));
  lights();
})();
