/** Incoming Slack files; outbound artifacts and cloud handoff have separate budgets. */
export const MAX_SLACK_ATTACHMENT_BYTES = 500 * 1024 * 1024
export const MAX_SLACK_THREAD_ATTACHMENT_BYTES = 1024 * 1024 * 1024
export const SLACK_ATTACHMENT_LIMIT_LABEL = '500MB'
export const SLACK_THREAD_ATTACHMENT_LIMIT_LABEL = '1GB'
