/* Keep the microphone page visible when the browser permits it. Not background-audio permission. */
(function (root) {
  "use strict";
  class ScreenAwake {
    constructor(onStatus = () => {}) {
      this.onStatus = onStatus;
      this.enabled = false;
      this.generation = 0;
      this.sentinel = null;
      this.pending = null;
    }
    async setEnabled(enabled) {
      this.enabled = Boolean(enabled);
      if (!this.enabled) {
        ++this.generation;
        const sentinel = this.sentinel;
        this.sentinel = null;
        if (sentinel) await sentinel.release().catch(() => {});
        this.onStatus("Pantalla activa desactivada.");
        return;
      }
      await this.acquire();
    }
    async acquire() {
      if (
        !this.enabled ||
        root.document.hidden ||
        this.sentinel ||
        this.pending
      )
        return;
      if (!root.navigator.wakeLock?.request) {
        this.onStatus(
          "Tu navegador no permite mantener la pantalla activa. Evita bloquearla mientras cantas.",
        );
        return;
      }
      const generation = this.generation;
      const request = root.navigator.wakeLock.request("screen");
      this.pending = request;
      try {
        const sentinel = await request;
        if (
          generation !== this.generation ||
          !this.enabled ||
          root.document.hidden
        ) {
          await sentinel.release().catch(() => {});
          return;
        }
        this.sentinel = sentinel;
        sentinel.addEventListener("release", () => {
          if (this.sentinel === sentinel) {
            this.sentinel = null;
            if (this.enabled)
              this.onStatus(
                "Pantalla activa interrumpida por el sistema. Evita bloquear el teléfono.",
              );
          }
        });
        this.onStatus("Pantalla activa mientras usas el micrófono.");
      } catch (_) {
        if (this.enabled)
          this.onStatus(
            "El sistema no permitió mantener la pantalla activa. Evita bloquearla.",
          );
      } finally {
        if (this.pending === request) this.pending = null;
        if (
          generation !== this.generation &&
          this.enabled &&
          !root.document.hidden
        )
          void this.acquire();
      }
    }
    async visibilityChanged() {
      if (!root.document.hidden) {
        await this.acquire();
        return;
      }
      ++this.generation;
      const sentinel = this.sentinel;
      this.sentinel = null;
      if (sentinel) await sentinel.release().catch(() => {});
    }
  }
  root.ScreenAwake = ScreenAwake;
})(window);
