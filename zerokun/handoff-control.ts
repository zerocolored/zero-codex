/** These are explicit controls, not general conversation intent detection.
 * Other messages continue through the existing LLM addressee classifier. */
export function handoffControl(text: string): 'handoff' | 'continue' | null {
  const command = text.trim().replace(/[。！!]+$/, '')
  if (['引き継いで', '引き継いでください'].includes(command)) return 'handoff'
  if (['続けて', '続けてください', '再開して', '再開してください'].includes(command)) return 'continue'
  return null
}
export function explicitlyAddressedHandoff(text: string, botId: string | undefined): boolean {
  if (!botId) return false
  const mentions = [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)]
  if (mentions.length !== 1 || mentions[0]![1] !== botId) return false
  return handoffControl(text.replace(mentions[0]![0], '')) !== null
}
