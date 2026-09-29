import { Lexer, Marked, type Token, type Tokens } from 'marked'

// Parse Markdown rather than replacing delimiters in URLs and code. Existing
// Slack control tokens are opaque, including their labels and mention IDs.
const markdown = new Marked({ gfm: true, extensions: [{
  name: 'slack', level: 'inline',
  start: source => source.indexOf('<'),
  tokenizer(source) {
    const match = /^<(?:[@#!][^<>\n]+|(?:https?:\/\/|mailto:)[^<>\n]+)>/.exec(source)
    if (match) return { type: 'slack', raw: match[0] }
  },
}] })

function childrenInRaw(raw: string, children: Token[]): string {
  let cursor = 0
  let output = ''
  for (const child of children) {
    const index = raw.indexOf(child.raw, cursor)
    if (index < 0) return raw // Unsupported structure: never discard content.
    // Slack leaves *完了*。 literal without a whitespace boundary (browser verified).
    const emphasis = child.type === 'strong' || (child.type === 'del' && child.raw.startsWith('~~'))
    const before = emphasis && index > 0 && /\S/.test(raw[index - 1]!) ? ' ' : ''
    const afterIndex = index + child.raw.length
    const after = emphasis && afterIndex < raw.length && /\S/.test(raw[afterIndex]!) ? ' ' : ''
    output += raw.slice(cursor, index) + before + render(child) + after
    cursor = index + child.raw.length
  }
  return output + raw.slice(cursor)
}

function withoutEmphasis(tokens: Token[]): string {
  return tokens.map(token => ['strong', 'em'].includes(token.type)
    ? withoutEmphasis((token as Tokens.Strong).tokens) : render(token)).join('')
}

function plainCode(text: string): string {
  // Removing code delimiters must not activate a literal mention or Slack link.
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function codeWithoutFormatting(code: Tokens.Code): string {
  // Interpret tables only. Source code such as "# comment" or "a * b * c"
  // must not be reinterpreted as Markdown prose when its fence is removed.
  let cursor = 0
  let output = ''
  for (const token of markdown.lexer(code.text)) {
    const nestedFence = token.type === 'code' && /^ {0,3}(?:`{3,}|~{3,})/.test(token.raw)
    if (token.type !== 'table' && !nestedFence) continue
    const index = code.text.indexOf(token.raw, cursor)
    if (index < 0) continue
    output += plainCode(code.text.slice(cursor, index))
    if (nestedFence) output += codeWithoutFormatting(token as Tokens.Code)
    else output += tableWithoutFormatting(token as Tokens.Table, true)
    cursor = index + token.raw.length
  }
  return output + plainCode(code.text.slice(cursor)) + (code.raw.match(/\n*$/)?.[0] ?? '')
}

function tableRowCells(line: string): string[] {
  const cells = ['']
  let slashes = 0
  for (const character of line.trim()) {
    const index = cells.length - 1
    if (character === '|' && slashes % 2 === 0) cells.push('')
    else if (character === '|') cells[index] = cells[index]!.slice(0, -1) + '|'
    else cells[index] += character
    slashes = character === '\\' ? slashes + 1 : 0
  }
  if (cells[0] === '') cells.shift()
  if (cells.at(-1) === '') cells.pop()
  return cells.map(cell => cell.trim())
}

function literalSlackTokens(tokens: Token[]): Token[] {
  return tokens.map(token => {
    if (token.type === 'slack') return { ...token, type: 'literal-slack' }
    const children = (token as Tokens.Generic).tokens
    return children ? { ...token, tokens: literalSlackTokens(children) } : token
  })
}

function tableWithoutFormatting(table: Tokens.Table, literalSlack = true): string {
  const safeTokens = (tokens: Token[]) => literalSlack ? literalSlackTokens(tokens) : tokens
  const labels = table.header.map((cell, index) => withoutEmphasis(safeTokens(cell.tokens)).trim() || `列${index + 1}`)
  if (!table.rows.length) return labels.map(label => `• ${label}`).join('\n') + '\n'
  const lines = table.raw.split('\n').slice(2)
  const headerOnly = !lines.slice(0, table.rows.length).some(line => line.includes('|'))
  const prefix = headerOnly ? labels.map(label => `• ${label}`).join('\n') + '\n\n' : ''
  return prefix + table.rows.map((row, rowIndex) => {
    const line = lines[rowIndex] ?? ''
    // The GFM lexer also absorbs the following prose when there is no blank
    // separator. Do not invent labelled empty cells for that ordinary sentence.
    if (!line.includes('|')) return childrenInRaw(line, safeTokens(new Lexer(markdown.defaults).inlineTokens(line)))
    // GFM truncates surplus cells to the header width. Slack delivery must not
    // silently discard those values when replacing the formerly verbatim table.
    const extra = tableRowCells(line).slice(labels.length)
    const values = row.map(cell => childrenInRaw(cell.text, safeTokens(cell.tokens)))
      .concat(extra.map(cell => childrenInRaw(cell, safeTokens(new Lexer(markdown.defaults).inlineTokens(cell)))))
    return values.map((value, index) => `${index ? '  ' : '• '}${labels[index] ?? `列${index + 1}`}: ${value}`)
      .join('\n')
  }).join('\n\n') + '\n'
}

function render(token: Token): string {
  switch (token.type) {
    case 'slack': return token.raw
    case 'literal-slack': return plainCode(token.raw)
    case 'codespan': return plainCode((token as Tokens.Codespan).text)
    case 'code': return codeWithoutFormatting(token as Tokens.Code)
    case 'strong': return '*' + withoutEmphasis((token as Tokens.Strong).tokens) + '*'
    case 'del': return '~' + (token as Tokens.Del).tokens.map(render).join('') + '~'
    case 'heading': {
      const heading = token as Tokens.Heading
      const content = withoutEmphasis(heading.tokens)
      return `*${content}*`
        + (token.raw.match(/\n*$/)?.[0] ?? '')
    }
    case 'link':
    case 'image': {
      const link = token as Tokens.Link
      // Bare URLs and existing mrkdwn must remain byte-for-byte unchanged.
      if (!/^!?\[/.test(link.raw)) return link.raw
      if (!/^(?:https?:\/\/|mailto:)/i.test(link.href)) return childrenInRaw(link.raw, link.tokens ?? [])
      const url = link.href.replace(/\|/g, '%7C').replace(/</g, '%3C').replace(/>/g, '%3E')
      const label = (link.tokens ? withoutEmphasis(link.tokens) : link.text)
        .replace(/\|/g, '｜').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return `<${url}|${label}>`
    }
    case 'table': return tableWithoutFormatting(token as Tokens.Table)
    case 'hr': return '────────' + (token.raw.match(/\n*$/)?.[0] ?? '')
    case 'blockquote': return (token as Tokens.Blockquote).tokens.map(render).join('').trimEnd().split('\n')
      .map(line => line ? `> ${line}` : line).join('\n') + (token.raw.match(/\n*$/)?.[0] ?? '')
    case 'list': {
      const list = token as Tokens.List
      return list.items.map((item, index) => {
        const marker = list.ordered ? `${Number(list.start) + index}. ` : '• '
        const content = item.tokens.map(render).join('').trimEnd()
        return marker + content.split('\n').join('\n' + ' '.repeat(marker.length))
      }).join('\n') + (token.raw.match(/\n*$/)?.[0] ?? '')
    }
    default: {
      const children = (token as Tokens.Generic).tokens
      return children ? childrenInRaw(token.raw, children) : token.raw
    }
  }
}

/** Send-boundary conversion only: stored answers/artifacts remain Markdown. */
export function toSlackMrkdwn(text: string): string {
  return markdown.lexer(text).map(render).join('')
}
