FROM node:20-alpine

WORKDIR /app
COPY server.js ./server.js
COPY users.json ./users.json

USER root
EXPOSE 8080
CMD ["node", "server.js"]
