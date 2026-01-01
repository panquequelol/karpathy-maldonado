FROM node:20-bookworm-slim

# Enable pnpm
RUN corepack enable pnpm && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (tsx is needed for runtime)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Create auth directory for Baileys session persistence
RUN mkdir -p /app/auth_info

# Set Node options for Effect.ts source map support
ENV NODE_ENV=production
ENV NODE_OPTIONS="--enable-source-maps"

# Run the application
CMD ["node", "-r", "dotenv/config", "index.ts"]
