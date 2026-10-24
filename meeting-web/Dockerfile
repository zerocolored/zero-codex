FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY meeting-web/service.ts meeting-web/server.ts meeting-web/avatar.ts meeting-web/build.ts ./meeting-web/
COPY meeting-web/public ./meeting-web/public
RUN bun meeting-web/build.ts
ENV PORT=3000 MEETING_DATA_DIR=/data
EXPOSE 3000
CMD ["bun", "--no-env-file", "meeting-web/server.ts"]
