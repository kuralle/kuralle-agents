FROM node:22.18.0-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# `kuralle build --target node` places a self-contained bundle beside this
# template. No source tree, package manager, or development dependency is copied.
COPY --chown=node:node server.mjs /app/server.mjs

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "/app/server.mjs"]
