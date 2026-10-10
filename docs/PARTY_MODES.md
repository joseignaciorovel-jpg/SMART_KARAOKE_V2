# FireVoice: iluminación, apoyo del público y desafíos

Esta versión es para una fiesta compartida y una instancia del servidor. No convierte todavía la aplicación en un SaaS con salas independientes.

## Uso

1. El anfitrión entra en la pantalla con la misma HOST_KEY. En su cabina elige ambiente (apagado, clásico, concierto, fiesta) e intensidad 0–70 %. Las luces están fuera del video; respetan movimiento reducido y no usan destellos.
2. Cada persona entra por el QR. En Canciones puede elegir a otra persona e invitar a un dueto, duelo o sorpresa. Las invitaciones duran 2 minutos y se aceptan/rechazan en el teléfono. No alteran el turno actual.
3. Dueto: un enlace, un turno y dos micrófonos locales. El sonido sigue saliendo por cada teléfono; no hay mezcla de voces en la TV ni sincronización garantizada de dispositivos.
4. Duelo: un enlace, dos turnos consecutivos de la misma canción. Al completar ambos se abre una votación de 30 segundos. El público conectado al abrir la ronda puede elegir una persona una vez; los contendientes no votan. Los porcentajes se revelan al cerrar. Empate y ausencia de votos no generan un ganador falso. Omitir o eliminar una actuación cancela el duelo.
5. Sorpresa: 2–5 enlaces distintos propuestos por quien invita y un tema/género escrito manualmente. Al aceptar se elige aleatoriamente un enlace, se revela la canción y entra a la cola para quien aceptó. No existe búsqueda de canciones ni catálogo externo.
6. Apoyo del público: durante cada actuación no-duelo se permite un apoyo por identidad, sin voto propio. Porcentaje = apoyos únicos / participantes que estuvieron conectados durante esa actuación y eran elegibles. Quien se incorpora se suma al público elegible; quien se desconecta conserva su elegibilidad. Las actuaciones sin público elegible se excluyen.
7. Ranking = promedio de los porcentajes por actuación completada, sin ponderar por tamaño de público. Primera actuación provisional, desde dos actuaciones entra al podio. Duetos se agrupan por la pareja de identidades y tienen ranking separado. Duelo no suma al ranking general. Reacciones repetidas no dan puntos individuales; las puntuaciones de equipos conservan su lógica de animación existente y no miden calidad vocal.
8. El final real del video en la pantalla autenticada registra la actuación y avanza. El anfitrión también puede usar Finalizar actuación. Siguiente la omite y excluye del ranking. Un video bloqueado se omite. Abrir el podio es una acción del anfitrión, para evitar que el público tape la canción.

## Conservar sesión

El backend guarda cola, historial, canción, identidades privadas, actuaciones/votos, duelos y opciones mediante escritura atómica de un JSON y una copia anterior. Lee el archivo al iniciar. Las invitaciones breves expiran al reiniciar. No se conserva la posición temporal de YouTube: la canción activa comienza desde el inicio. Nunca se restaura un micrófono abierto automáticamente.

- `SESSION_DATA_DIR` debe apuntar a almacenamiento persistente fuera de `public/`. En Railway se puede usar directamente `RAILWAY_VOLUME_MOUNT_PATH`, o establecer `SESSION_DATA_DIR=/data` después de montar un volumen en `/data`.
- Sin volumen/configuración, no se escribe una copia efímera fingiendo persistencia. La cabina muestra que el guardado automático está pendiente; permite descargar/restaurar una copia privada. Una recarga de la página conserva estado mientras el servidor sigue vivo; un reinicio requiere volumen o restauración manual.
- Copias privadas contienen tokens de acceso de participantes. No publicarlas ni guardarlas en el repositorio. Exportar/restaurar exige anfitrión; restaurar exige que los participantes salgan y una confirmación de reemplazo.
- Datos corruptos impiden el arranque para evitar sobrescribir la única copia. Revisar `session.json.previous` con acceso de administrador si fuera necesario.
- Límites acotados para esta versión: 200 turnos, 500 identidades, 500 actuaciones, 100 duelos, 500 KB por copia. No borrar identidades de una fiesta en curso: rompería turnos y reconexión.

## Alcance y crecimiento

La identidad se conserva con un token privado por pestaña. No equivale a una persona verificada: alguien puede crear otra identidad. Esta primera votación es apropiada para una fiesta de confianza, no para concursos con premios. Una versión profesional deberá añadir salas, autorización por sala, identidad consistente, reglas contra abuso y una base de datos compartida antes de múltiples réplicas.

El almacenamiento JSON mantiene la implementación pequeña para una sola fiesta. No habilitar múltiples réplicas con este diseño. El volumen conserva datos pero no reemplaza una estrategia de copias externas.

## Validación

Pruebas de Socket.IO con servidor real para autorización, consentimiento, cancelación, duetos, dos turnos, votación y opciones. Pruebas del motor para porcentajes, provisorios, votos únicos, cierre temporal, empate y ausencia de votos. Reinicio de dos procesos reales confirma recuperación de cola, identidades, votos e iluminación. JSDOM verifica renderizado como texto, cambio entre dos turnos del mismo video, controles y estados. La mezcla acústica de dos teléfonos y la disponibilidad de cada video necesitan prueba física.

## Configuración de stickers

Se retiró la credencial Giphy incrustada en la versión anterior. Configurar `GIPHY_KEY` como variable del servicio para habilitar stickers; sin ella el endpoint responde 503. No se copian secretos de producción a la prueba.
