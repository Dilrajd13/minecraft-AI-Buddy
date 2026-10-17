import { config, loadPersona, log } from './config.js'

const GOALS = ['follow', 'come', 'guard', 'goto', 'collect', 'give', 'stop']

const SET_GOAL_TOOL = {
  type: 'function',
  function: {
    name: 'set_goal',
    description: 'Change what you are doing in the game. follow = follow the owner around; come = walk to the owner once; ' +
      'guard = stay here and kill anything that comes near; goto = walk to x y z; collect = mine/gather a block type; ' +
      'give = bring an item from your inventory to the owner; stop = stand still.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', enum: GOALS },
        block: { type: 'string', description: 'for collect: block name like oak_log, wood, stone, iron, diamond, dirt' },
        count: { type: 'integer', description: 'for collect/give: how many' },
        item: { type: 'string', description: 'for give: item name' },
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }
      },
      required: ['goal']
    }
  }
}

const TEXT_GOAL_HINT = '\nTo change what you are doing, end your reply with ONE line exactly like one of these:\n' +
  '[goal: follow] [goal: come] [goal: guard] [goal: stop] [goal: collect block=oak_log count=10] ' +
  '[goal: give item=bread count=3] [goal: goto x=10 y=64 z=-20]'

// The "personality" brain: Gemma 4 (or any OpenAI-compatible chat model). Slow-ish, so it only
// handles talking and picking big goals; the fast brain does the twitchy combat stuff.
export class TalkBrain {
  constructor ({ getWorld, onGoal, onReply }) {
    this.getWorld = getWorld
    this.onGoal = onGoal
    this.onReply = onReply
    this.persona = loadPersona()
    this.overrides = []
    this.history = []
    this.busy = false
    this.pending = null
    this.useTools = true
    this.tokens = { in: 0, out: 0 }
  }

  setPersona (text) { this.persona = text; this.history = [] }
  resetPersona () { this.persona = loadPersona(); this.overrides = []; this.history = [] }

  systemPrompt () {
    let s = this.persona
    if (this.overrides.length) {
      s += '\n\nACTIVE BEHAVIOR OVERRIDES from your owner (these beat everything above, follow them hard):\n' +
        this.overrides.map((o, i) => `${i + 1}. ${o}`).join('\n')
    }
    if (!this.useTools) s += TEXT_GOAL_HINT
    s += `\n\nWhat you can see right now:\n${this.getWorld()}`
    return s
  }

  // kind: 'owner' (owner talked), 'chat' (someone else), 'event' (game event to react to)
  async hear (kind, text) {
    const line = kind === 'event' ? `[game event] ${text}` : text
    if (this.busy) {
      // Never drop the owner talking; events can be dropped if we're already mid-reply
      if (kind !== 'event' || !this.pending) this.pending = line
      return
    }
    this.busy = true
    try {
      let next = line
      while (next) {
        const reply = await this.complete(next)
        if (reply) this.onReply(reply)
        next = this.pending
        this.pending = null
      }
    } finally {
      this.busy = false
    }
  }

  async complete (userLine) {
    this.history.push({ role: 'user', content: userLine })
    if (this.history.length > 20) this.history.splice(0, this.history.length - 20)
    const messages = [{ role: 'system', content: this.systemPrompt() }, ...this.history]

    let msg
    try {
      msg = await this.request(messages)
    } catch (err) {
      if (this.useTools && /tool/i.test(err.message)) {
        log('talk', 'model has no tool calling here, switching to text goals')
        this.useTools = false
        messages[0].content = this.systemPrompt()
        msg = await this.request(messages).catch(e => { log('talk', e.message); return null })
      } else {
        log('talk', err.message)
        msg = null
      }
    }
    if (!msg) { this.history.pop(); return null }

    let text = (msg.content ?? '').trim()
    for (const call of msg.tool_calls ?? []) {
      if (call.function?.name !== 'set_goal') continue
      try { this.onGoal(JSON.parse(call.function.arguments || '{}')) } catch (e) { log('talk', 'bad tool args', e.message) }
    }
    const m = text.match(/\[goal:\s*(\w+)([^\]]*)\]/i)
    if (m) {
      const args = { goal: m[1].toLowerCase() }
      for (const [, k, v] of m[2].matchAll(/(\w+)=(\S+)/g)) args[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
      if (GOALS.includes(args.goal)) this.onGoal(args)
      text = text.replace(m[0], '').trim()
    }
    // Don't keep tool_calls in history; providers get picky about tool-message pairing
    this.history.push({ role: 'assistant', content: text || '(does it)' })
    return cleanForSpeech(text)
  }

  async request (messages) {
    const isOllama = config.talk.provider === 'ollama'
    const url = isOllama ? `${config.talk.ollamaUrl}/v1/chat/completions` : 'https://openrouter.ai/api/v1/chat/completions'
    const headers = { 'Content-Type': 'application/json' }
    if (!isOllama) {
      if (!config.openrouterKey) throw new Error('no OPENROUTER_API_KEY set')
      headers.Authorization = `Bearer ${config.openrouterKey}`
      headers['X-Title'] = 'minecraft-buddy'
    }
    const body = {
      model: config.talk.model,
      messages,
      max_tokens: 120,
      temperature: 1.0,
      top_p: 0.95
    }
    if (this.useTools) body.tools = [SET_GOAL_TOOL]
    const res = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(isOllama ? 60000 : 20000)
    })
    if (!res.ok) throw new Error(`talk brain HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const json = await res.json()
    this.tokens.in += json.usage?.prompt_tokens ?? 0
    this.tokens.out += json.usage?.completion_tokens ?? 0
    return json.choices?.[0]?.message
  }
}

export function cleanForSpeech (text) {
  return (text || '')
    .replace(/\*[^*]*\*/g, '') // *stage directions*
    .replace(/<\|?think\|?>[\s\S]*?(<\/?\|?think\|?>|$)/gi, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[#_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
