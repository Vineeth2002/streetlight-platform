FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:20-alpine AS production
WORKDIR /app

RUN addgroup -g 1001 nodeapp && adduser -u 1001 -G nodeapp -s /bin/sh -D nodeapp

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=nodeapp:nodeapp . .

RUN mkdir -p logs && chown nodeapp:nodeapp logs

USER nodeapp
EXPOSE 3000

CMD ["node", "src/index.js"]