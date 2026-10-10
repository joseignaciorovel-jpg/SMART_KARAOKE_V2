/* Existing party clips plus original synthesized effects. No remote sound API. */
(function (root) {
  "use strict";
  const catalog = [
    {
      id: "aplausos",
      name: "Aplausos",
      icon: "👏",
      file: "aplausos.wav",
      duration: 2500,
    },
    {
      id: "ovacion",
      name: "Ovación",
      icon: "🙌",
      file: "ovacion.mp3",
      duration: 3000,
    },
    {
      id: "multitud",
      name: "Gritos del público",
      icon: "📣",
      file: "multitud.wav",
      duration: 2500,
    },
    { id: "animo", name: "¡Vamos!", icon: "🔥", voice: "¡Vamos! ¡Bravo!" },
    { id: "silbido", name: "Silbido festivo", icon: "🎶", synth: "whistle" },
    { id: "zampona", name: "Zampoña", icon: "🪈", synth: "panpipe" },
    {
      id: "abucheo",
      name: "Abucheo",
      icon: "👻",
      voice: "Buuu",
      optional: true,
    },
  ];
  class AudienceSounds {
    constructor(volume = 0.35) {
      this.volume = volume;
      this.context = null;
      this.audio = null;
      this.timer = null;
      this.gains = new Set();
    }
    setVolume(volume) {
      this.volume = Math.max(0, Math.min(0.7, Number(volume) || 0));
      if (this.audio) {
        this.audio.volume = this.volume;
        if (!this.volume) this.audio.pause();
      }
      for (const gain of this.gains)
        gain.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.02);
    }
    prepare() {
      try {
        const AudioContext = root.AudioContext || root.webkitAudioContext;
        if (!this.context && AudioContext) this.context = new AudioContext();
        if (this.context?.state === "suspended")
          void this.context.resume().catch(() => {});
      } catch (_) {}
    }
    stopClip() {
      clearTimeout(this.timer);
      this.audio?.pause();
      this.audio = null;
    }
    dispose() {
      this.stopClip();
      const context = this.context;
      this.context = null;
      this.gains.clear();
      if (context) void context.close().catch(() => {});
    }
    async play(id, maxDuration) {
      const item = catalog.find((s) => s.id === id);
      if (!item) return { ok: false, message: "Sonido no disponible." };
      if (this.volume <= 0)
        return {
          ok: false,
          message: "El volumen de los sonidos está silenciado.",
        };
      this.stopClip();
      try {
        if (item.file) {
          const audio = new root.Audio("/assets/sounds/" + item.file);
          this.audio = audio;
          audio.volume = this.volume;
          await audio.play();
          if (this.audio !== audio) {
            audio.pause();
            return { ok: false, message: "Sonido reemplazado." };
          }
          this.timer = setTimeout(() => {
            audio.pause();
            if (this.audio === audio) this.audio = null;
          }, maxDuration || item.duration);
        } else if (item.voice) {
          if (!root.speechSynthesis || !root.SpeechSynthesisUtterance)
            return {
              ok: false,
              message: "Este navegador no tiene voz de ánimo disponible.",
            };
          const speech = new root.SpeechSynthesisUtterance(item.voice);
          speech.lang = "es";
          speech.volume = this.volume;
          speech.pitch = id === "abucheo" ? 0.45 : 1.1;
          speech.rate = id === "abucheo" ? 0.7 : 1.15;
          root.speechSynthesis.speak(speech);
        } else {
          this.prepare();
          const ctx = this.context;
          if (!ctx)
            return {
              ok: false,
              message: "Tu navegador no permite este efecto.",
            };
          await ctx.resume();
          const master = ctx.createGain();
          master.gain.value = this.volume;
          master.connect(ctx.destination);
          this.gains.add(master);
          const notes =
            item.synth === "whistle"
              ? [{ f: 1300, to: 1850, d: 0.75 }]
              : [
                  { f: 392, to: 390, d: 0.32 },
                  { f: 349, to: 347, d: 0.32 },
                  { f: 294, to: 291, d: 0.5 },
                ];
          let offset = 0,
            remaining = notes.length;
          for (const note of notes) {
            const osc = ctx.createOscillator(),
              envelope = ctx.createGain(),
              start = ctx.currentTime + offset;
            osc.type = item.synth === "whistle" ? "sine" : "triangle";
            osc.frequency.setValueAtTime(note.f, start);
            osc.frequency.linearRampToValueAtTime(note.to, start + note.d);
            envelope.gain.setValueAtTime(0, start);
            envelope.gain.linearRampToValueAtTime(0.25, start + 0.05);
            envelope.gain.linearRampToValueAtTime(0, start + note.d);
            osc.connect(envelope);
            envelope.connect(master);
            osc.onended = () => {
              osc.disconnect();
              envelope.disconnect();
              if (--remaining === 0) {
                master.disconnect();
                this.gains.delete(master);
              }
            };
            osc.start(start);
            osc.stop(start + note.d);
            offset += note.d;
          }
        }
        return { ok: true, message: "Sonido reproducido." };
      } catch (_) {
        return {
          ok: false,
          message:
            "No se pudo reproducir. Pulsa Probar para habilitar el audio en este dispositivo.",
        };
      }
    }
  }
  AudienceSounds.catalog = catalog;
  root.AudienceSounds = AudienceSounds;
})(window);
