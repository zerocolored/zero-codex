import { Marked, type Token, type Tokens } from 'marked'

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

function render(token: Token): string {
  switch (token.type) {
    case 'slack':
    case 'codespan': return token.raw
    case 'code': {
      const code = token as Tokens.Code
      if (!/^ {0,3}(?:`{3,}|~{3,})/.test(code.raw)) return `\`\`\`\n${code.text}\n\`\`\`\n`
      // Slack does not recognize the optional Markdown language annotation.
      const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(code.raw)
      if (!fence) return code.raw
      const body = code.raw.slice(fence[0].length)
      const close = new RegExp(`\\n {0,3}${fence[1]![0]}{${fence[1]!.length},}[ \\t]*(\\n*)$`)
      if (!close.test('\n' + body)) return code.raw
      return '```\n' + body.replace(close, '\n```$1')
    }
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
      if (!/^!?\[/.test(link.raw) || !/^(?:https?:\/\/|mailto:)/i.test(link.href)) return link.raw
      const url = link.href.replace(/\|/g, '%7C').replace(/</g, '%3C').replace(/>/g, '%3E')
      const label = (link.tokens ? withoutEmphasis(link.tokens) : link.text)
        .replace(/\|/g, '｜').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return `<${url}|${label}>`
    }
    case 'table': return '```\n' + token.raw.trimEnd() + '\n```\n'
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
