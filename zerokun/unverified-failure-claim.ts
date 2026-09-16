/**
 * 「やっていないことを、やって失敗したと報告する」を機械で検出する。
 *
 * 2026-09-16、本番セッションの調査を3回依頼して3回とも実データを引かず、
 * 理由を尋ねると「dotenvx の起動失敗と管理APIの401で止まり、chat_histories への
 * 直接問い合わせを試しませんでした」と答えた。しかし実行ログ上 dotenvx は
 * 3回の調査でも、その回答の回でも **1度も動いていない**。
 * 接続も鍵も揃っており（同じ permission profile で Supabase へ HTTP 401 到達を実測）、
 * 失敗して諦めたのではなく、失敗したという話自体が事実と違った。
 *
 * 手順書を足しても効かない。素のターミナル codex は手順書なしで同じ結論へ辿り着く。
 * 効くのは「その機構が失敗したと書くなら、それを実行した記録を要求する」検査だけ。
 *
 * 過検出を避けるため、次の両方が揃ったときだけ拾う。
 *   1. 回答が **具体的な機構名**（dotenvx / supabase / gcloud …）を挙げている
 *   2. 同じ文が失敗・不能を主張している
 * 「情報が足りない」「再現できない」のように機構を名指ししないものは対象外。
 */
import { readFileSync } from 'fs'

/** 主張された機構と、それを裏づける実行コマンドの対応表。 */
interface MechanismRule {
  /** 検出結果に出す機構名。 */
  readonly mechanism: string
  /** 回答文の中でこの機構を指す語。 */
  readonly claimed: RegExp
  /** 実行コマンド側で「実際に試した」と認める語。 */
  readonly evidence: RegExp
  /** 違反時に人へ出すヒント。 */
  readonly evidenceHint: string
}

const MECHANISMS: readonly MechanismRule[] = [
  {
    mechanism: 'dotenvx',
    claimed: /dotenvx/i,
    evidence: /dotenvx/i,
    evidenceHint: 'npx dotenvx run -- …（実際に dotenvx を起動する）',
  },
  {
    mechanism: 'supabase',
    claimed: /supabase|chat_histories|qa_pipeline_traces|rest\/v1/i,
    evidence: /supabase|chat_histories|qa_pipeline_traces|rest\/v1|psql/i,
    evidenceHint: 'curl "$SUPABASE_URL/rest/v1/<table>?…"（実際に問い合わせる）',
  },
  {
    mechanism: 'gcloud',
    claimed: /gcloud|cloud logging|cloud run/i,
    evidence: /gcloud/i,
    evidenceHint: 'gcloud logging read …（実際に取得する）',
  },
  {
    mechanism: 'github',
    claimed: /\bgh\b|github api/i,
    evidence: /\bgh\b|api\.github\.com/i,
    evidenceHint: 'gh api … / gh run view …（実際に叩く）',
  },
]

/**
 * 失敗・不能の主張。
 * 「試していません」のような**やっていないと正直に書いた文**は対象にしない。
 * 問題は「試して駄目だった」と書くことなので、そこだけを拾う。
 */
const FAILURE_CLAIM =
  /(失敗|エラー|落ち|止まり|止まっ|できません|できなかった|不能|到達できな|接続できな|取得できな|読めません|読めなかった|unavailable|failed|cannot connect|could not)/i

/** 明示的に「試していない」と書いている文は、事実に反しないので除外する。 */
const HONEST_NOT_ATTEMPTED = /(試していません|試しませんでした|実行していません|未実施|試さず)/

export interface UnverifiedFailureClaim {
  /** 主張された機構名。 */
  readonly mechanism: string
  /** 根拠になった回答中の一文。 */
  readonly sentence: string
  /** 実行されているべきだったコマンドの例。 */
  readonly evidenceHint: string
}

/**
 * Codex の stdout JSONL から、このターンで実行されたコマンドを抜き出す。
 *
 * ログが読めない・壊れている場合は空配列を返す。**検査そのものを理由に
 * ジョブを落とさない**（検査が落とすのは「主張と記録の食い違い」だけ）。
 */
export function extractExecutedCommands(stdoutLogPath: string): string[] {
  let raw: string
  try {
    raw = readFileSync(stdoutLogPath, 'utf8')
  } catch {
    return []
  }
  const commands: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.includes('commandExecution')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const envelope = parsed as { params?: { item?: unknown }, item?: unknown }
    const item = (envelope.params?.item ?? envelope.item) as
      { type?: unknown, command?: unknown } | undefined
    if (!item || item.type !== 'commandExecution') continue
    if (typeof item.command === 'string' && item.command.length > 0) {
      commands.push(item.command)
    }
  }
  return commands
}

/**
 * 句点だけでなく読点でも切る。
 *
 * 「dotenvx の起動失敗と管理APIの401で止まり、chat_histories への直接問い合わせを
 * 試しませんでした。」のように、**1文の中に「失敗した」と「試していない」が同居する**
 * ことがある。文単位で見ると後半の正直な申告に引きずられて前半の虚偽を見逃す。
 */
function clauses(text: string): string[] {
  return text
    .split(/(?<=[。．.!?！？、，\n])/)
    .map(value => value.trim())
    .filter(value => value.length > 0)
}

/**
 * 「この機構が失敗した」と書いているのに、その機構を実行した記録が無い主張を返す。
 * 該当が無ければ空配列。
 */
export function findUnverifiedFailureClaims(
  finalMessage: string,
  executedCommands: readonly string[],
): UnverifiedFailureClaim[] {
  if (!finalMessage.trim()) return []
  const found: UnverifiedFailureClaim[] = []
  const seen = new Set<string>()
  for (const sentence of clauses(finalMessage)) {
    if (!FAILURE_CLAIM.test(sentence)) continue
    if (HONEST_NOT_ATTEMPTED.test(sentence)) continue
    for (const rule of MECHANISMS) {
      if (seen.has(rule.mechanism)) continue
      if (!rule.claimed.test(sentence)) continue
      if (executedCommands.some(command => rule.evidence.test(command))) continue
      seen.add(rule.mechanism)
      found.push({
        mechanism: rule.mechanism,
        sentence,
        evidenceHint: rule.evidenceHint,
      })
    }
  }
  return found
}

/** 違反を人が読める1本のメッセージにする。 */
export function describeUnverifiedFailureClaims(
  claims: readonly UnverifiedFailureClaim[],
): string {
  return [
    '回答が「試して失敗した」と書いている機構を、このターンでは一度も実行していません。',
    ...claims.map(claim => (
      `- ${claim.mechanism}: 「${claim.sentence}」`
      + ` / 実行されているべきだったもの: ${claim.evidenceHint}`
    )),
    '実際に実行して結果を確かめるか、実行していない事実をそのまま書いてください。',
  ].join('\n')
}
