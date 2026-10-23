import { createMeetingService } from './service.ts'

const service = createMeetingService({
  directory: process.env.MEETING_DATA_DIR ?? '/data',
  origin: process.env.MEETING_ORIGIN ?? '',
  adminToken: process.env.MEETING_ADMIN_TOKEN ?? '',
  apiKey: process.env.OPENAI_API_KEY ?? '',
  allowLocalhost: process.env.MEETING_LOCAL_DEVELOPMENT === '1',
})
const server = Bun.serve({ hostname: '0.0.0.0', port: Number(process.env.PORT ?? 3000),
  maxRequestBodySize: 9 * 1024 * 1024, idleTimeout: 60, fetch: service.fetch })
console.log(`Meeting service listening on port ${server.port}`)
