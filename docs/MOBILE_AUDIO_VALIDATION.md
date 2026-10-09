# FireVoice — audio local y UX móvil

## Qué cambia

El micrófono del celular se conecta a Web Audio en el mismo dispositivo:

`getUserMedia → fuente → filtro pasaaltos → voz seca / eco opcional → compresor → ganancia → salida del sistema`.

El analizador mide la entrada antes de la ganancia de salida. La ganancia comienza en 15% y la salida queda silenciada hasta una acción del usuario. El modo Normal desconecta la contribución de eco. El eco suave utiliza un delay de 140 ms sin realimentación. El compresor reduce picos; no elimina el acople acústico ni garantiza ausencia de saturación.

No se utiliza MediaRecorder, no se registra la voz y no se transmiten fragmentos de audio por Socket.IO. Música y letra continúan en la pantalla de YouTube; la voz sale por el dispositivo de salida del teléfono. Los eventos Socket.IO transmiten canciones, identidades de sesión, turnos, reacciones y efectos.

La interfaz permite probar el micrófono antes del turno. Solo el cantante y los cocantantes pueden enviar un efecto de voz al resto del dúo. Cada cocantante debe activar su propio audio. Se detiene la captura al cambiar de canción, desconectarse, salir o pasar a segundo plano. Volver a la página requiere una nueva activación; la salida no se reanuda de forma audible automáticamente.

## Configuración antes de publicar

1. Definir `HOST_KEY` con una clave única y fuerte mediante la configuración segura del servidor. No incorporarla al código ni a GitHub. Sin esta variable los controles quedan bloqueados y se muestra una explicación.
2. Abrir la pantalla y entrar a **Controles del anfitrión**. La clave se guarda solo en memoria de esa pestaña; al recargar se debe ingresar nuevamente. La autorización del servidor es por conexión y se vuelve a comprobar al reconectar.
3. Usar HTTPS en dispositivos móviles. `http://localhost` permite pruebas locales en el computador, pero un teléfono accediendo a una IP local por HTTP no habilita necesariamente la captura.
4. Ejecutar `npm ci`, `npm run check` y `npm test`. Arrancar con `npm start`. `.env.example` es referencia: el servidor no carga archivos `.env` automáticamente.

## Verificación automatizada

- Grafo local conectado a salida, salida inicialmente silenciada y eco desactivado en Normal.
- Ganancia limitada y silencio inmediato; cierre de pistas, nodos y contexto.
- Permiso denegado, cancelación mientras se espera permiso, suspensión y cierre durante reanudación.
- Identidades diferentes para apodos iguales; el token privado no aparece en el estado público.
- Recuperación de sesión y canción después de reconectar mientras el servidor sigue activo.
- Comprobación de permisos de anfitrión y aceptación de dúos asociados a una canción vigente.
- Ausencia de retransmisión del antiguo evento `mic-audio`.
- Navegación móvil, confirmación de escucha, limpieza al cambiar de canción y mensajes de desconexión.
- Nombres y títulos se insertan como texto en la nueva interfaz; etiquetas en controles de la pantalla.

Las pruebas de audio utilizan simulaciones de Web Audio; las de interfaz utilizan JSDOM y las de sesión ejecutan el servidor Socket.IO real con metadatos de YouTube simulados. Estas pruebas no comprueban sonido, renderizado en Safari, potencia del altavoz o latencia física.

## Prueba física pendiente — requisito antes de producción

Registrar modelo, versión del sistema, navegador y dispositivo de salida. Ejecutar en al menos un iPhone/Safari y un Android/Chrome.

| Prueba | Criterio de aceptación |
| --- | --- |
| Permiso | La solicitud aparece al activar; denegar muestra cómo recuperar; cancelar no deja captura después de aceptar tardíamente. |
| Captura | Hablar mueve el medidor; el silencio lo reduce. El medidor no se presenta como prueba de reproducción. |
| Salida local | Tras habilitar, la voz sale por el teléfono/dispositivo conectado y no por la pantalla. Confirmar escucha manualmente. |
| Volumen/acople | Empezar con volumen bajo. Subir gradualmente con la música habitual; no aprobar un nivel que produzca pitidos o distorsión. Silenciar debe cortar inmediatamente. |
| Latencia | Medir extremo a extremo con una referencia física o grabación externa; no deducirla de `baseLatency`. Objetivo exploratorio ≤50 ms en configuraciones declaradas compatibles, aún sin demostrar. |
| Continuidad | Diez minutos sin cortes, acumulación de retraso ni acople al volumen validado. |
| Interrupciones | Bloqueo de pantalla, aplicación en segundo plano o llamada no recuperan una salida audible automáticamente. Reabrir y reactivar. |
| Turno/reconexión | Cambiar de canción o perder la conexión detiene la captura; reconectar recupera identidad sin reactivar el audio. |
| Dúo | Dos celulares capturan sus propias voces y salen localmente; verificar acople entre ambos. |
| Accesibilidad | Zoom, foco, lectura de nombres de botones y pantalla estrecha de 320/390 px sin controles inaccesibles. |

Si el altavoz integrado no entrega volumen útil sin acople, informar la limitación y validar una salida externa separada (preferiblemente cableada). No prometer que el navegador puede forzar altavoz integrado, auricular o Bluetooth. Bluetooth puede añadir retraso y alterar el micrófono elegido.

## Límites y próximos pasos

- Prototipo de audio local: la calidad depende del teléfono, navegador, volumen y entorno acústico. No reemplaza de forma garantizada un micrófono y amplificador dedicados.
- Una sola sala global. Cola, puntajes, sesiones e invitaciones se conservan en memoria; reiniciar el servicio los pierde. No hay persistencia ni escalado de salas en esta entrega.
- Los controles de anfitrión tienen autorización de servidor. Esto no constituye una auditoría integral de seguridad de las integraciones Giphy/ElevenLabs.
- No se ofrecen Helio/Monstruo hasta disponer de procesamiento de tono probado. El código anterior solo cambiaba avisos.
- El modo inalámbrico hacia la pantalla queda fuera de esta entrega. Requiere WebRTC, señalización, receptor explícito y pruebas de red; no reutilizar fragmentos MediaRecorder como transporte de karaoke.
- No fusionar en `main` hasta aprobar la prueba física y preparar HOST_KEY: Railway tiene producción vinculada a esa rama y una fusión podría desplegar automáticamente.
