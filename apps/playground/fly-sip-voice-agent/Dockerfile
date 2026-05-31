FROM node:24-slim

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server-sip-realtime.mjs .

# HTTP health check on 3000, SIP on 5060, RTP on 10000-10100
EXPOSE 3000
EXPOSE 5060/udp
EXPOSE 10000-10100/udp

CMD ["node", "server-sip-realtime.mjs"]
