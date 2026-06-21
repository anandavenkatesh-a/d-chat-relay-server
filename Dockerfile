FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

# Non-root user for security
RUN addgroup -S relay && adduser -S relay -G relay
USER relay

EXPOSE 8080

CMD ["node", "src/server.js"]
