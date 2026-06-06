# Usar la imagen oficial ligera de Node.js 18
FROM node:18-alpine

# Definir el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copiar los archivos de definición de paquetes
COPY package*.json ./

# Instalar dependencias limpias de producción
RUN npm install --only=production

# Copiar el código fuente de la aplicación
COPY . .

# Exponer el puerto por defecto (Cloud Run usualmente inyecta PORT=8080, server.js escucha en process.env.PORT)
EXPOSE 3000

# Comando para arrancar el servidor
CMD ["node", "server.js"]
