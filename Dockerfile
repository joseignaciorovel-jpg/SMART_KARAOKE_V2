# Usar la imagen oficial ligera de Node.js 20
FROM node:20-alpine

# Definir el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copiar los archivos de definición de paquetes
COPY package*.json ./

# Instalar dependencias limpias de producción
RUN npm ci --omit=dev

# Copiar el código fuente de la aplicación
COPY . .

# Exponer el puerto por defecto (Cloud Run usualmente inyecta PORT=8080, server.js escucha en process.env.PORT)
EXPOSE 3000

# Comando para arrancar el servidor
CMD ["node", "server.js"]
