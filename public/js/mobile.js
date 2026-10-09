/* Participant UI. Socket.IO carries game state only; audio stays local. */
(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const socket = io();
    const storage = {
        get() { try { return JSON.parse(sessionStorage.getItem('firevoice-session') || 'null'); } catch (_) { return null; } },
        set(value) { try { sessionStorage.setItem('firevoice-session', JSON.stringify(value)); } catch (_) {} },
        clear() { try { sessionStorage.removeItem('firevoice-session'); } catch (_) {} }
    };
    let session = storage.get(), joined = false, activeSongId = null, receivedState = false;
    let canSing = false, totalClicks = 0, invitation = null, submitting = false, joinPending = false;
    let feedbackTimer, heard = false, outputVersion = 0;
    const statusNames = { idle: 'Micrófono detenido', requesting: 'Esperando permiso', ready: 'Entrada preparada · salida silenciada', muted: 'Salida silenciada', output: 'Salida habilitada', interrupted: 'Audio interrumpido', error: 'No se pudo activar' };
    function notify(message) {
        $('feedback').textContent = message; $('feedback').hidden = false;
        clearTimeout(feedbackTimer); feedbackTimer = setTimeout(() => { $('feedback').hidden = true; }, 8000);
    }
    const audio = new LocalAudioEngine({
        onState({ state, message, muted }) {
            $('micStatus').textContent = statusNames[state]; $('micMessage').textContent = message;
            const active = ['ready', 'muted', 'output', 'interrupted'].includes(state);
            $('audioControls').hidden = !active;
            $('micBtn').hidden = active;
            $('micBtn').disabled = state === 'requesting' || !joined || !socket.connected;
            $('micBtn').textContent = state === 'requesting' ? 'Solicitando permiso…' : 'Activar micrófono';
            $('cancelMicBtn').hidden = state !== 'requesting';
            $('muteBtn').textContent = muted ? 'Habilitar salida' : 'Silenciar';
            $('muteBtn').classList.toggle('danger', !muted);
            $('heardBtn').disabled = state !== 'output';
            if (state !== 'output') { heard = false; ++outputVersion; }
            $('heardStatus').textContent = heard ? 'Escucha confirmada por ti.' : 'Escucha pendiente de comprobar.';
        },
        onLevel({ rms, peak }) {
            $('inputLevel').value = Math.min(1, rms * 4);
            $('levelText').textContent = !audio.stream ? 'Sin captura' : peak >= 0.95 ? 'Entrada saturada: aleja el teléfono o reduce el nivel.' : rms > 0.005 ? 'Señal de entrada detectada' : 'Entrada baja: habla cerca del micrófono.';
        }
    });
    $('micBtn').onclick = () => { if (joined && socket.connected) void audio.start(); };
    $('stopMicBtn').onclick = () => void audio.stop();
    $('cancelMicBtn').onclick = () => void audio.stop();
    $('muteBtn').onclick = async () => {
        const version = ++outputVersion;
        heard = false;
        await audio.setMuted(!audio.muted);
        if (version !== outputVersion) return;
        $('heardStatus').textContent = 'Escucha pendiente de comprobar.';
    };
    $('heardBtn').onclick = () => {
        if (audio.state !== 'output') return;
        heard = true; $('heardStatus').textContent = 'Escucha confirmada por ti.';
    };
    $('gainControl').oninput = e => {
        audio.setGain(e.target.value / 100); $('gainValue').value = `${e.target.value}%`;
        heard = false; $('heardStatus').textContent = 'Nivel cambiado. Comprueba la escucha.';
    };
    $('voiceEffect').onchange = e => {
        audio.setEffect(e.target.value);
        if (canSing) socket.emit('trigger-voice-effect', e.target.value);
    };
    // Suspension, phone calls and background tabs must never resume an audible mic silently.
    document.addEventListener('visibilitychange', () => { if (document.hidden) void audio.stop(); });
    window.addEventListener('pagehide', () => void audio.stop());
    function chooseTab(tabId) {
        document.querySelectorAll('.tab-panel').forEach(panel => { panel.hidden = panel.id !== tabId; });
        document.querySelectorAll('[data-tab]').forEach(button => {
            if (button.dataset.tab === tabId) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        });
    }
    document.querySelectorAll('[data-tab]').forEach(button => { button.onclick = () => chooseTab(button.dataset.tab); });
    function enterSession() {
        if (!session || !socket.connected) return;
        joinPending = true; $('enterBtn').disabled = true;
        socket.emit('join-team', { nickname: session.nickname, team: session.team, sessionToken: session.sessionToken });
    }
    socket.on('connect', () => {
        $('connectionStatus').textContent = 'Conectado';
        if (session) enterSession();
        socket.emit('get-state');
    });
    socket.on('disconnect', () => {
        joined = false; joinPending = false; $('connectionStatus').textContent = 'Sin conexión';
        $('enterBtn').disabled = false; $('micBtn').disabled = true;
        void audio.stop(); notify('Se perdió la conexión. El micrófono se detuvo; vuelve a activarlo cuando reconecte.');
    });
    socket.on('connect_error', () => { $('connectionStatus').textContent = 'Reconectando…'; });
    socket.on('error-msg', notify);
    $('joinForm').onsubmit = e => {
        e.preventDefault();
        if (joinPending) return;
        if (!socket.connected) return notify('Espera a que se restablezca la conexión.');
        session = { nickname: $('nicknameInput').value.trim(), team: document.querySelector('input[name=team]:checked').value };
        if (!session.nickname) return;
        enterSession();
    };
    socket.on('nickname-set', data => {
        joined = true; joinPending = false; session = data; storage.set(data);
        $('loginSection').hidden = true; $('mainSection').hidden = false;
        $('enterBtn').disabled = false; $('micBtn').disabled = false;
        $('userTeamBadge').textContent = `${data.nickname} · ${data.team === 'red' ? '🔴 Rojo' : '🔵 Azul'}`;
        socket.emit('get-state');
    });
    $('leaveBtn').onclick = async () => {
        await audio.stop(); session = null; joined = false; storage.clear();
        socket.disconnect(); socket.connect();
        $('mainSection').hidden = true; $('loginSection').hidden = false;
        $('inviteDialog').close(); $('receiveDialog').close();
        invitation = null; totalClicks = 0; updateEnergy();
    };
    function updateEnergy() {
        $('energyText').textContent = `${Math.max(0, 1000 - totalClicks)} reacciones disponibles`;
        $('clapBtn').disabled = $('screamBtn').disabled = totalClicks >= 1000;
    }
    function react(type) {
        if (!joined || !socket.connected) return notify('Conéctate al show para reaccionar.');
        if (totalClicks >= 1000) return;
        socket.emit('submit-claps', { claps: type === 'claps' ? 1 : 0, screams: type === 'screams' ? 1 : 0 });
        totalClicks++; updateEnergy();
    }
    $('clapBtn').onclick = () => react('claps'); $('screamBtn').onclick = () => react('screams');
    $('chacalBtn').onclick = () => {
        if (!socket.connected) return notify('Sin conexión al show.');
        socket.emit('vote-chacal'); notify('Voto enviado.');
    };
    document.querySelectorAll('[data-effect]').forEach(button => { button.onclick = () => {
        if (socket.connected) socket.emit('trigger-effect', button.dataset.effect);
    }; });
    $('rankingBtn').onclick = () => socket.emit('request-final-ranking');
    $('songForm').onsubmit = e => {
        e.preventDefault(); if (submitting) return;
        if (!socket.connected || !joined) return notify('Conéctate antes de añadir una canción.');
        submitting = true; $('addSongBtn').disabled = true; $('addSongBtn').textContent = 'Añadiendo…';
        socket.timeout(12000).emit('add-song', { url: $('youtubeUrlInput').value.trim() }, (error, result) => {
            submitting = false; $('addSongBtn').disabled = false; $('addSongBtn').textContent = 'Añadir a la cola';
            if (error) return notify('No pudimos confirmar la solicitud. Revisa la cola antes de volver a enviarla.');
            notify(result.message);
            if (result.ok) $('youtubeUrlInput').value = '';
        });
    };
    socket.on('state-update', data => {
        const newId = data.currentSong?.id || null;
        if (receivedState && newId !== activeSongId) {
            void audio.stop(); totalClicks = 0; updateEnergy();
            $('voiceEffect').value = 'normal'; audio.setEffect('normal');
            $('receiveDialog').close(); $('inviteDialog').close(); invitation = null;
        }
        receivedState = true; activeSongId = newId;
        canSing = Boolean(session && data.currentSong && (data.currentSong.requesterId === session.participantId || data.coSingerIds?.includes(session.participantId)));
        $('inviteBtn').hidden = !canSing;
        $('currentSongTitle').textContent = data.currentSong?.title || 'Todavía no hay canciones';
        $('turnLabel').textContent = canSing ? 'ES TU MOMENTO' : data.currentSong ? 'AHORA EN EL ESCENARIO' : 'ESPERANDO EL SHOW';
        const ownIndex = (data.queue || []).findIndex(song => song.requesterId === session?.participantId);
        $('turnDescription').textContent = canSing ? 'Activa tu micrófono y comprueba la salida antes de cantar.' : ownIndex >= 0 ? `Tu próximo turno está en la posición ${ownIndex + 1} de la cola.` : data.currentSong ? `Canta ${data.currentSong.requester}. Puedes probar tu micrófono mientras esperas.` : 'Añade una canción para entrar en la cola.';
        $('scoreboard').hidden = data.gameMode === 'arcade';
        if (data.teamScores) updateScores(data.teamScores);
        const list = $('songQueue'); list.replaceChildren();
        if (!data.queue?.length) { const item = document.createElement('li'); item.textContent = 'La cola está vacía.'; list.append(item); }
        else data.queue.forEach(song => {
            const item = document.createElement('li'); item.textContent = song.title;
            const caption = document.createElement('small'); caption.textContent = song.requester;
            item.append(caption); list.append(item);
        });
        const effect = canSing ? data.activeVoiceEffect || 'normal' : audio.effect;
        audio.setEffect(effect); $('voiceEffect').value = audio.effect;
    });
    function updateScores(scores) { $('redPoints').textContent = scores.red || 0; $('bluePoints').textContent = scores.blue || 0; }
    socket.on('team-scores', updateScores);
    socket.on('voice-effect-changed', ({ effect }) => {
        if (!canSing) return;
        audio.setEffect(effect); $('voiceEffect').value = audio.effect;
    });
    $('inviteBtn').onclick = () => socket.emit('get-participants');
    socket.on('participants-list', list => {
        $('inviteList').replaceChildren();
        list.filter(person => person.id !== socket.id).forEach(person => {
            const button = document.createElement('button'); button.textContent = person.name;
            button.onclick = () => { socket.emit('invite-participant', { targetSocketId: person.id }); $('inviteDialog').close(); notify('Invitación enviada.'); };
            $('inviteList').append(button);
        });
        if (!$('inviteList').children.length) $('inviteList').textContent = 'No hay otros participantes conectados.';
        if (!$('inviteDialog').open) $('inviteDialog').showModal();
    });
    $('closeInviteBtn').onclick = () => $('inviteDialog').close();
    socket.on('receive-invitation', data => {
        invitation = data; $('invitationText').textContent = `${data.fromName} te invita a cantar esta canción.`;
        if (!$('receiveDialog').open) $('receiveDialog').showModal();
    });
    $('acceptInviteBtn').onclick = () => {
        if (invitation) socket.emit('accept-invitation', invitation.fromId);
        $('receiveDialog').close(); invitation = null;
    };
    $('rejectInviteBtn').onclick = () => { $('receiveDialog').close(); invitation = null; };
    socket.on('invitation-accepted', () => { chooseTab('sing'); notify('Dúo aceptado. Cada cantante activa su micrófono en su propio celular.'); });
    $('stickerForm').onsubmit = async e => {
        e.preventDefault(); const container = $('giphyResults'); container.textContent = 'Buscando…';
        try {
            const response = await fetch(`/api/giphy?q=${encodeURIComponent($('giphySearch').value || 'party')}`);
            if (!response.ok) throw new Error('search');
            const data = await response.json(); container.replaceChildren();
            (data.data || []).forEach(sticker => {
                const button = document.createElement('button'); button.setAttribute('aria-label', `Enviar sticker: ${sticker.title || 'animación'}`);
                const img = document.createElement('img'); img.src = sticker.images.fixed_height.url; img.alt = ''; img.loading = 'lazy';
                button.append(img); button.onclick = () => socket.emit('send-sticker', img.src); container.append(button);
            });
            if (!container.children.length) container.textContent = 'No encontramos stickers con esa búsqueda.';
        } catch (_) { container.textContent = 'No se pudo buscar. Vuelve a intentarlo.'; }
    };
})();
