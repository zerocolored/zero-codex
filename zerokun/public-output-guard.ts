import { UTS39_ASCII_SKELETON_GROUPS } from './uts39-ascii-skeleton'

const CREDENTIAL_PATTERN_SOURCES = [
  String.raw`xox[a-z]-[A-Za-z0-9._-]{12,}`,
  String.raw`xapp-[A-Za-z0-9._-]{12,}`,
  String.raw`sk-[A-Za-z0-9_-]{20,}`,
  String.raw`gh[pousr]_[A-Za-z0-9_]{20,}`,
  String.raw`github_pat_[A-Za-z0-9_]{20,}`,
  String.raw`npm_[A-Za-z0-9]{20,}`,
  String.raw`AKIA[A-Z0-9]{16}`,
  String.raw`\bAuthorization\s*:\s*Bearer(?:\s+[A-Za-z0-9._~+\/=\-]+)?`,
  String.raw`\b(?:Authorization\s*:\s*)?Bearer\s+(?!(?:authentication|tokens?|scheme|header)\s+(?:is|are|uses?|means?)\b)[A-Za-z0-9._~+\/=\-]+`,
  String.raw`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*(?![A-Za-z0-9_-])`,
  String.raw`-----BEGIN [A-Z ]+PRIVATE KEY-----`,
  String.raw`(?:password|passwd|api[_-]?key|access[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}`,
] as const

const PERCENT_ENCODED_TOKEN = /[^\s`'"<>。、！？!?;,()\[\]{}]*%[0-9a-f]{2}[^\s`'"<>。、！？!?;,()\[\]{}]*/gi

function decodePercentLayers(value: string): { decoded: string; stable: boolean } {
  let decoded = value
  for (let round = 0; round < 4; round += 1) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, run => {
      try {
        return decodeURIComponent(run)
      } catch {
        return run.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => (
          String.fromCharCode(Number.parseInt(hex, 16))
        ))
      }
    })
    if (next === decoded) return { decoded: normalizePublicGuardText(decoded), stable: true }
    decoded = next
  }
  const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, run => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => (
        String.fromCharCode(Number.parseInt(hex, 16))
      ))
    }
  })
  return {
    decoded: normalizePublicGuardText(decoded),
    stable: next === decoded,
  }
}

function directCredentialMatch(value: string): boolean {
  return CREDENTIAL_PATTERN_SOURCES.some(source => new RegExp(source, 'i').test(value))
}

/**
 * Normalize text before checking anything that must not cross a public or
 * advisor boundary. NFKC closes compatibility-spelling variants and removing
 * every default-ignorable, format, and non-text control character closes invisible
 * token/path/name splitting across Slack and advisor boundaries.
 */
export function normalizePublicGuardText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
}

const UTS39_ASCII_SKELETON = new Map<string, string>()
for (const [target, sources] of UTS39_ASCII_SKELETON_GROUPS) {
  for (const source of sources) UTS39_ASCII_SKELETON.set(source, target)
}

/**
 * Build a detector-only UTS #39 skeleton for the ASCII alphabet used by the
 * protected implementation names. The generated table is pinned to a Unicode
 * release; public text is never rewritten with the skeleton.
 */
export function normalizeImplementationGuardText(value: string): string {
  const detectorInput = value
    .normalize('NFD')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
  return [...detectorInput]
    .map(character => UTS39_ASCII_SKELETON.get(character) ?? character)
    .join('')
    .normalize('NFD')
}

export function containsCredentialMaterial(value: string): boolean {
  const normalized = normalizePublicGuardText(value)
  if (directCredentialMatch(normalized)) return true
  return [...normalized.matchAll(new RegExp(PERCENT_ENCODED_TOKEN.source, 'gi'))]
    .some(match => {
      const inspection = decodePercentLayers(match[0])
      return !inspection.stable || directCredentialMatch(inspection.decoded)
    })
}

export function redactCredentialMaterial(value: string, replacement: string): string {
  let sanitized = normalizePublicGuardText(value)
  sanitized = sanitized.replace(
    new RegExp(PERCENT_ENCODED_TOKEN.source, 'gi'),
    token => {
      const inspection = decodePercentLayers(token)
      return !inspection.stable || directCredentialMatch(inspection.decoded)
        ? replacement
        : token
    },
  )
  for (const source of CREDENTIAL_PATTERN_SOURCES) {
    sanitized = sanitized.replace(new RegExp(source, 'gi'), replacement)
  }
  return sanitized
}
