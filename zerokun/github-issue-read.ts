import { z } from 'zod'
import type { GitHubPublicationCommands } from './github-publication.ts'
import { containsCredentialMaterial } from './public-output-guard.ts'

const cursor = z.string().min(1).max(1024).regex(/^[A-Za-z0-9+/=_-]+$/)
export const githubIssueInput = {
  repository: z.string().max(256).describe('Exact owner/name from the current project.'),
  issueNumber: z.number().int().positive().max(2_147_483_647),
  commentsLimit: z.number().int().min(1).max(20).default(20),
  before: cursor.optional().describe('Returned olderCommentsCursor; omit to read the latest comments.'),
}

// Variables are transported as JSON on stdin, never interpolated into the query.
const query = `query ZerochanIssue($owner: String!, $name: String!, $number: Int!, $last: Int!, $before: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issue(number: $number) {
      number title body url state createdAt updatedAt
      comments(last: $last, before: $before) {
        totalCount
        pageInfo { hasPreviousPage hasNextPage startCursor }
        nodes { id body url createdAt updatedAt author { login } }
      }
    }
  }
}`

const date = z.string().datetime()
const commentSchema = z.object({
  id: z.string().min(1), body: z.string(), url: z.string(),
  createdAt: date, updatedAt: date,
  author: z.object({ login: z.string() }).nullable(),
})
const responseSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z.object({ repository: z.object({
    nameWithOwner: z.string(),
    issue: z.object({
      number: z.number().int().positive(), title: z.string(), body: z.string(),
      url: z.string(), state: z.enum(['OPEN', 'CLOSED']), createdAt: date, updatedAt: date,
      comments: z.object({
        totalCount: z.number().int().nonnegative(),
        pageInfo: z.object({ hasPreviousPage: z.boolean(), hasNextPage: z.boolean(), startCursor: cursor.nullable() }),
        nodes: z.array(commentSchema),
      }),
    }).nullable(),
  }).nullable() }).nullable(),
})

export async function readGitHubIssue(
  commands: GitHubPublicationCommands,
  input: z.infer<z.ZodObject<typeof githubIssueInput>>,
  signal?: AbortSignal,
) {
  const [owner, name] = input.repository.split('/')
  const response = await commands.runGh(['api', 'graphql', '--input', '-'], JSON.stringify({
    query, variables: { owner, name, number: input.issueNumber, last: input.commentsLimit, before: input.before ?? null },
  }), signal)
  if (response.exitCode !== 0) {
    throw new Error(`GitHub issue read failed with exit ${response.exitCode}${response.timedOut ? ' (timeout)' : ''}`)
  }
  if (Buffer.byteLength(response.stdout) > 2 * 1024 * 1024) {
    throw new Error('GitHub issue response is too large; retry with a smaller commentsLimit')
  }
  // Check before parsing or selecting fields so credentials cannot hide in omitted metadata.
  if (containsCredentialMaterial(response.stdout)) {
    throw new Error('GitHub issue response contained protected credential material')
  }
  let parsed: unknown
  try { parsed = JSON.parse(response.stdout) } catch { throw new Error('GitHub issue returned invalid JSON') }
  const validated = responseSchema.safeParse(parsed)
  if (!validated.success || validated.data.errors?.length) {
    throw new Error('GitHub issue returned an incomplete or invalid response')
  }
  const repository = validated.data.data?.repository
  const issue = repository?.issue
  if (!repository || !issue) throw new Error('GitHub issue was not found or is not accessible')
  const expectedUrl = `https://github.com/${input.repository}/issues/${input.issueNumber}`
  if (repository.nameWithOwner.toLowerCase() !== input.repository.toLowerCase()
    || issue.number !== input.issueNumber || issue.url.toLowerCase() !== expectedUrl.toLowerCase()) {
    throw new Error('GitHub issue response does not match the requested repository and issue')
  }
  const { nodes, pageInfo, totalCount } = issue.comments
  if (nodes.length > input.commentsLimit || nodes.length > totalCount
    || new Set(nodes.map(node => node.id)).size !== nodes.length
    || (pageInfo.hasPreviousPage && (!pageInfo.startCursor || nodes.length !== input.commentsLimit))
    || (!input.before && pageInfo.hasNextPage)
    || (!pageInfo.hasPreviousPage && !pageInfo.hasNextPage && nodes.length !== totalCount)) {
    throw new Error('GitHub issue comment pagination is incomplete or inconsistent')
  }
  for (const comment of nodes) {
    const url = new URL(comment.url)
    if (`${url.origin}${url.pathname}`.toLowerCase() !== expectedUrl.toLowerCase()
      || url.username || url.password || url.search || !/^#issuecomment-\d+$/.test(url.hash)) {
      throw new Error('GitHub issue comment URL does not match the requested issue')
    }
  }
  const { comments: _comments, ...fields } = issue
  return {
    complete: true,
    repository: repository.nameWithOwner,
    fetchedAt: new Date().toISOString(),
    contentTrust: 'untrusted-reference-data',
    issue: fields,
    comments: nodes,
    returnedComments: nodes.length,
    totalComments: totalCount,
    allCommentsIncluded: !pageInfo.hasPreviousPage && !pageInfo.hasNextPage,
    hasOlderComments: pageInfo.hasPreviousPage,
    hasNewerComments: pageInfo.hasNextPage,
    olderCommentsCursor: pageInfo.hasPreviousPage ? pageInfo.startCursor : null,
  }
}
