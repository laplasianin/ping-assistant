export type Command =
  | { kind: 'choose'; itemId: string; n: number }
  | { kind: 'skip'; itemId: string }
  | { kind: 'custom'; itemId: string; text: string }
  | { kind: 'confirm'; itemId: string }
  | { kind: 'force'; itemId: string }
  | { kind: 'cancel'; itemId: string }
  | { kind: 'forward'; itemId?: string; text: string }

const LEADING_ID = /^#?(\d+(?:\.\d+)?)(?=:|\s)/

function applyRules(itemId: string, rest: string): Command {
  const r = rest.trim()
  if (r.startsWith(':')) {
    const text = r.slice(1).trim()
    if (text) return { kind: 'custom', itemId, text }
  }
  if (/^да$/i.test(r)) return { kind: 'confirm', itemId }
  if (/^(пропустить|skip)$/i.test(r)) return { kind: 'skip', itemId }
  if (/^\d+$/.test(r)) return { kind: 'choose', itemId, n: Number(r) }
  return { kind: 'forward', itemId, text: r }
}

export function parseText(text: string, quotedItemId?: string): Command {
  const t = text.trim()
  const m = LEADING_ID.exec(t)
  if (m) return applyRules(m[1], t.slice(m[0].length))
  if (quotedItemId) return applyRules(quotedItemId, t)
  return { kind: 'forward', text: t }
}

export function parseCallback(data: string): Command | null {
  const parts = data.split(':')
  if (parts[0] !== 'pa') return null
  const [, action, itemId, n] = parts
  if (!itemId) return null
  if (action === 'choose') {
    return n !== undefined && /^\d+$/.test(n) && parts.length === 4 ? { kind: 'choose', itemId, n: Number(n) } : null
  }
  if (parts.length !== 3) return null
  if (action === 'skip' || action === 'confirm' || action === 'force' || action === 'cancel') return { kind: action, itemId }
  return null
}

export function callbackData(cmd: Exclude<Command, { kind: 'forward' | 'custom' }>): string {
  return cmd.kind === 'choose' ? `pa:choose:${cmd.itemId}:${cmd.n}` : `pa:${cmd.kind}:${cmd.itemId}`
}
