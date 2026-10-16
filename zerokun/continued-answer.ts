// Normal final messages are replies too, even when the native goal subsequently
// continues to a waiting state. Do not classify their meaning by language/length.
const MAX_RETAINED_CHARS = 1024 * 1024
// Leave room below the host's 12K result cap for delivery status/coverage text.
const MAX_DELIVERY_CHARS = 11_000

export interface ContinuedAnswerPlan {
  messages: string[]
  marker: string
  omitted: boolean
}

export class ContinuedAnswer {
  private revision?: number
  private messages: string[] = []
  private chars = 0
  private omitted = false

  observe(message: string, revision: number): void {
    if (this.revision !== revision) {
      this.revision = revision
      this.messages = []
      this.chars = 0
      this.omitted = false
    }
    let text = message.trim()
    if (!text) return
    if (text.length > MAX_RETAINED_CHARS) {
      text = text.slice(0, MAX_RETAINED_CHARS)
      this.omitted = true
    }
    // Keep the latest occurrence: A -> correction B -> correction A must end A.
    const duplicate = this.messages.indexOf(text)
    if (duplicate >= 0) {
      this.messages.splice(duplicate, 1)
      this.chars -= text.length
    }
    while (this.messages.length && this.chars + text.length > MAX_RETAINED_CHARS) {
      this.chars -= this.messages.shift()!.length
      this.omitted = true
    }
    this.messages.push(text)
    this.chars += text.length
  }

  plan(finalMessage: string, revision: number, goalStatus: string | undefined): ContinuedAnswerPlan | undefined {
    if (this.revision !== revision || !['blocked', 'paused'].includes(goalStatus ?? '')) return undefined
    // The artifact resolver has already selected/validated the only declaration
    // eligible for delivery. Keep that declaration at the end, never older ones.
    const opening = /<zerokun_files>/i.exec(finalMessage)
    const marker = opening ? /^<zerokun_files>[\s\S]*<\/zerokun_files>\s*$/i.exec(finalMessage.slice(opening.index))?.[0].trim() : ''
    if (opening && !marker) return undefined
    const selected = finalMessage.trim()
    const observed = [...this.messages]
    if (!observed.includes(selected)) observed.push(selected)
    const messages = observed.flatMap(message => {
      const declaration = /<zerokun_files>/i.exec(message)
      if (!declaration) return [message]
      // Discard replaced, withdrawn, changed or invalid attachment messages.
      return message === selected ? [message.slice(0, declaration.index).trimEnd()] : []
    }).filter(Boolean)
    return { messages, marker: marker ?? '', omitted: this.omitted }
  }

  // Information-preserving emergency rendering. Normal multi-answer delivery
  // uses semantic consolidation, never this exact-match-only concatenation.
  resolve(finalMessage: string, revision: number, goalStatus: string | undefined): string {
    const plan = this.plan(finalMessage, revision, goalStatus)
    if (!plan) return finalMessage
    const { messages, marker } = plan
    const attach = (text: string) => marker ? `${text}\n${marker}` : text
    const combined = messages.join('\n\n')
    if (!this.omitted && combined.length <= MAX_DELIVERY_CHARS) return attach(combined)
    // Reserve space newest-first, then render in chronological order. A short
    // correction before a final wait must outrank an old, very long explanation.
    const notice = '※ 長い説明を一部省略しました。\n\n'
    let available = MAX_DELIVERY_CHARS - notice.length
    const retained: string[] = []
    for (let index = messages.length - 1; index >= 0; index--) {
      const separator = retained.length ? 2 : 0
      if (available <= separator) break
      const text = messages[index]!
      retained.unshift(text.slice(0, available - separator))
      available -= Math.min(text.length, available - separator) + separator
      if (available === 0) break
    }
    return attach(notice + retained.join('\n\n'))
  }
}
