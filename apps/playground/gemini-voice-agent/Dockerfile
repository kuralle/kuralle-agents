FROM node:24-slim

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server-livekit-cascaded.mjs .
COPY google-stt.mjs .
COPY client.html .

EXPOSE 3000

CMD ["node", "server-livekit-cascaded.mjs"]
