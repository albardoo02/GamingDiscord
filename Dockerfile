FROM node:18

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json first (if available) for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application files
COPY --chown=node:node . .

# Run the application
USER node
CMD ["node", "index.js"]
