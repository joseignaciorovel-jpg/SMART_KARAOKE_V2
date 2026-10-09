# FireVoice: pantalla del show

Esta revisión se prepara en `feat/mobile-local-audio` y se publica solo en el servicio `firevoice-prueba`. `main` y el servicio original no cambian.

## Diseño

- Marca FireVoice, bienvenida inmediata con QR generado por el servidor y acceso directo al control móvil.
- Entrada del anfitrión mediante HOST_KEY existente; clave solo en memoria de la pestaña. Puede bloquear controles sin cerrar el show.
- Video 16:9 y barra vertical continua de 14 px: conserva gradiente multicolor y reacción a la energía del público. La barra no mide audio del micrófono.
- Nombre del cantante y canción debajo; siguiente turno destacado; público ve hasta tres turnos adicionales y el total. Anfitrión puede revisar y eliminar toda la cola.
- Panel lateral adaptativo; distribución de una columna en pantallas estrechas.
- Pantalla completa conserva la distribución. Modo escenario ocupa el viewport con video y barra. Escape y el botón visible de salida restauran el show; controles accesibles por teclado. Son funciones distintas.
- Espera útil con instrucciones; errores de YouTube visibles. Las letras siguen siendo parte del video, no se generan ni sincronizan por la aplicación.

## Reacciones

- Fiesta por defecto: el Chacal aparece con zampoña sin pausar música. Una llamada por participante por canción; intervalo global entre intervenciones.
- Competencia: el anfitrión lo habilita; 50 % de participantes conectados desencadena una pausa de hasta cinco segundos. Evento ligado a la canción. No reanuda una canción distinta, una reproducción previamente pausada ni una pausa explícita del anfitrión.
- Aplausos y ovación usan archivos existentes. Abucheo sintético breve mediante la voz del navegador; disponibilidad y timbre dependen del navegador. Deshabilitado hasta que el anfitrión lo permita.
- Volumen de efectos local a cada pantalla (0–70 %, inicial 35 %), independiente del micrófono local y de la música. Intervalo de seis segundos entre sonidos. No hay efectos aleatorios de multitud durante el canto.
- Configuración Chacal/abucheo compartida por sesión; se pierde al reiniciar el servicio, igual que cola y puntajes. Ningún servicio adicional de pago.

## Verificación

Pruebas de Socket.IO con autorización real del servidor, estados de Fiesta/Competencia, eventos asociados a la canción. Pruebas DOM de bienvenida/QR, acceso del anfitrión, modo escenario/Escape y reanudación del Chacal. Pruebas existentes de captura móvil y enlaces YouTube se mantienen.

Comprobar físicamente en notebook y TV: legibilidad a distancia, escaneo QR, reproducción YouTube, pantalla completa y sonido de efectos. El diseño no replica letras ficticias o avatares de la maqueta; muestra datos reales del show.
