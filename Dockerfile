FROM node:18

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json first (if available) for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application files
COPY --chown=node:node . .

# logger.js writes to ./logs, so the non-root user must own the working directory
RUN mkdir -p /app/logs && chown node:node /app /app/logs

# Run the application
USER node
CMD ["node", "index.js"]
