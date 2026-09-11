FROM node:20-alpine

WORKDIR /app

# Install system utilities needed for building native modules
RUN apk add --no-cache python3 make g++ git curl

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3001

HEALTHCHECK --interval=20s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3001/health || exit 1

CMD ["node", "server.js"]
