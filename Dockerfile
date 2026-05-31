FROM oven/bun:1.1

WORKDIR /app

# Copy ONLY the hospital-demo package.json to the ROOT of the container
# This forces Bun to treat it as a standalone app and ignore monorepo workspaces
COPY apps/playground/hospital-demo/package.json ./

# Install dependencies (will fetch from registry)
RUN bun install

# Copy the rest of the hospital-demo code to the root
COPY apps/playground/hospital-demo ./

# Expose the port (Server uses PORT env or 3000 by default, 3333 was in previous config)
# Railway usually provides PORT, so 3000 is a safe default.
EXPOSE 3000

# Start the server
# Note: we are now at the root of the app in /app
CMD ["bun", "run", "server.ts"]
