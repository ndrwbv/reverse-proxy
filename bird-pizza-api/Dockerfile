FROM node:24-alpine
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY server.mjs ./
USER node
EXPOSE 8081
CMD ["node", "server.mjs"]
