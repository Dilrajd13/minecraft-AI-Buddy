import { config, loadPersona, log } from './config.js'

const GOALS = ['follow', 'come', 'guard', 'goto', 'get', 'collect', 'hunt', 'craft', 'give', 'equip', 'eat', 'sleep', 'store', 'take', 'smelt', 'build', 'task', 'stop']

const SET_GOAL_TOOL = {
  type: 'function',
  function: {
    name: 'set_goal',
    description: 'Actually DO something in the game (talking about it does nothing). ' +
      'follow = follow the owner around; come = walk to the owner once; guard = stay here and kill anything that comes near; ' +
      'get = GET ANY ITEM by working out every step yourself (e.g. get iron: makes a pickaxe first if needed, which needs sticks, which need planks, which need wood...). Use get for almost anything: iron, diamonds, wood, cobblestone, torches, an iron pickaxe, food, cooked food, glass; ' +
      'goto = walk to x y z, or to a remembered place by name; collect = mine/gather a block type (for ores like iron/coal/diamond he finds them or takes safe stairs down); hunt = kill mobs and pick up their drops (mob=food kills any food animals nearby; or a type like zombie); ' +
      'craft = craft N more of an item (gets every missing ingredient and tool on the way); ' +
      'give = bring items to the owner (item=all for everything except your gear, item=food for all food); equip = hold a tool/weapon or wear armor; ' +
      'eat = eat food; sleep = sleep in a nearby bed; stop = stand still; ' +
      'store = put items in the nearest chest (item=all keeps your tools/armor); take = get items out of a chest (you remember what is in chests you opened); ' +
      'build = build a structure: a known blueprint (hut, cabin, tower, wall, or a saved one) or describe a new one (e.g. small stone house with a tower) and you will design it; optional material to build it out of; ' +
      'smelt = cook/smelt items in a furnace (raw_iron, raw_gold, sand, beef...; makes and places a furnace if needed, handles fuel); ' +
      'task = ANYTHING else or multi-step jobs (build a house, make a stone pickaxe from scratch, light the area with torches, farm, dig a tunnel...): describe it clearly in the task field and you will figure out the steps.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', enum: GOALS },
        block: { type: 'string', description: 'for collect: block name like oak_log, wood, stone, iron, diamond, dirt' },
        mob: { type: 'string', description: 'for hunt: food (any food animal), or a mob name like cow, pig, zombie, skeleton' },
        item: { type: 'string', description: 'for get/craft/give/equip/store/take/smelt: item name like crafting_table, stone_sword, raw_iron, cobblestone, all' },
        count: { type: 'integer', description: 'for collect/hunt/craft/give: how many' },
        structure: { type: 'string', description: 'for build: blueprint name or a description of what to build' },
        material: { type: 'string', description: 'for build (optional): main material, e.g. cobblestone, spruce_planks' },
        task: { type: 'string', description: 'for task: what to do in plain English, with details (sizes, materials, where)' },
        place: { type: 'string', description: 'for goto: name of a remembered place, e.g. base' },
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }
      },
      required: ['goal']
    }
  }
}

const REMEMBER_TOOL = {
  type: 'function',
  function: {
    name: 'remember',
    description: 'Save something to your long-term memory (kept forever, across sessions). ' +
      'kind=place saves where you are standing right now under a name (when the owner says "this is our base", "remember this spot"). ' +
      'kind=note saves a fact worth remembering (owner likes/hates something, a running joke, a promise, something that happened).',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['place', 'note'] },
        name: { type: 'string', description: 'for place: short name like base, iron cave, farm' },
        text: { type: 'string', description: 'for note: the fact, short' }
      },
      required: ['kind']
    }
  }
}

const ACT_RULE = '\n\nIMPORTANT: words alone do nothing in the game. Every time you agree to do something, you MUST ' +
  'also call set_goal in the same reply, or you will just stand there like an idiot. ' +
  'For getting or making items always use goal get (it figures out tools and materials itself) instead of guessing steps. ' +
  'If something failed, read the error: it says exactly what is missing.'

const TEXT_GOAL_HINT = '\nTo actually do something, end your reply with ONE line exactly like one of these:\n' +
  '[goal: get item=iron_pickaxe count=1] [goal: get item=raw_iron count=10] [goal: follow] [goal: come] [goal: guard] [goal: stop] [goal: eat] [goal: sleep] [goal: collect block=oak_log count=10] ' +
  '[goal: hunt mob=cow count=3] [goal: craft item=wooden_pickaxe count=1] [goal: equip item=iron_sword] ' +
  '[goal: give item=bread count=3] [goal: goto x=10 y=64 z=-20] [goal: goto place=base] [goal: store item=all] [goal: take item=iron_ingot count=5] [goal: smelt item=raw_iron count=8] [goal: build structure=cabin material=spruce_planks] [goal: task task=build_a_small_dirt_hut_here]\n' +
  'To save something to long-term memory add: [remember: place name=base] or [remember: note text=owner_hates_spiders]'

// Written into his chat memory so he remembers what he did, in the same format he can use to act
function goalTag (args) {
  const extras = Object.entries(args).filter(([k, v]) => k !== 'goal' && v !== undefined && v !== '').map(([k, v]) => `${k}=${v}`)
  return `[goal: ${[args.goal, ...extras].join(' ')}]`
}

// The "personality" brain: Gemma 4 (or any OpenAI-compatible chat model). Slow-ish, so it only
// handles talking and picking big goals; the fast brain does the twitchy combat stuff.
export class TalkBrain {
  constructor ({ getWorld, onGoal, onReply, memory, onRemember }) {
    this.getWorld = getWorld
    this.onGoal = onGoal
    this.onReply = onReply
    this.memory = memory
    this.onRemember = onRemember ?? ((args) => memory?.remember(args.kind, args.name, args.text))
    this.persona = loadPersona()
    this.overrides = []
    this.history = [...(memory?.recentChat ?? [])] // pick up where we left off last session
    this.busy = false
    this.pending = null
    this.useTools = true
    this.tokens = { in: 0, out: 0 }
    this.linesSinceSummary = 0
  }

  setPersona (text) { this.persona = text; this.history = [] }
  resetPersona () { this.persona = loadPersona(); this.overrides = []; this.history = [] }

  systemPrompt () {
    let s = this.persona
    if (this.overrides.length) {
      s += '\n\nACTIVE BEHAVIOR OVERRIDES from your owner (these beat everything above, follow them hard):\n' +
        this.overrides.map((o, i) => `${i + 1}. ${o}`).join('\n')
    }
    s += ACT_RULE
    s += '\nWhen the owner names a place or tells you something worth keeping, call remember.'
    if (this.memory) s += `\n\n${this.memory.describe()}`
    if (!this.useTools) s += TEXT_GOAL_HINT
    s += `\n\nWhat you can see right now:\n${this.getWorld()}`
    return s
  }

  // kind: 'owner' (owner talked), 'chat' (someone else), 'event' (game event to react to),
  // 'self' (autonomy: nobody asked, decide what to do on your own)
  async hear (kind, text) {
    const line = kind === 'event' ? `[game event] ${text}` : kind === 'self' ? `[your own initiative] ${text}` : text
    const droppable = kind === 'event' || kind === 'self'
    if (this.busy) {
      // Never drop the owner talking; events/initiative can be dropped if we're already mid-reply
      if (!droppable || !this.pending) this.pending = { kind, line }
      return false
    }
    this.busy = true
    try {
      let next = { kind, line }
      while (next) {
        this.currentKind = next.kind // so goals know who asked (only the owner may start free-form tasks)
        const reply = await this.complete(next.line)
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
    if (this.history.length > 24) this.history.splice(0, this.history.length - 24)
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
    const done = []
    for (const call of msg.tool_calls ?? []) {
      if (call.function?.name === 'remember') {
        try { log('memory', this.onRemember(JSON.parse(call.function.arguments || '{}'))) } catch (e) { log('talk', 'bad remember args', e.message) }
        continue
      }
      if (call.function?.name !== 'set_goal') continue
      try {
        const args = JSON.parse(call.function.arguments || '{}')
        if (args.task) args.task = cleanTask(args.task)
        if (GOALS.includes(args.goal)) { this.onGoal(args, this.currentKind); done.push(args) }
      } catch (e) { log('talk', 'bad tool args', e.message) }
    }
    for (const m of [...text.matchAll(/\[goal:\s*(\w+)([^\]]*)\]/gi)]) {
      const args = { goal: m[1].toLowerCase() }
      if (args.goal === 'task') args.task = cleanTask(m[2])
      else if (args.goal === 'build') {
        const mat = m[2].match(/material=(\S+)/)
        if (mat) args.material = mat[1]
        args.structure = cleanTask(m[2].replace(/material=\S+/, '').replace(/^\s*structure\s*[:=]/, ''))
      }
      else for (const [, k, v] of m[2].matchAll(/(\w+)=(\S+)/g)) args[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
      if (GOALS.includes(args.goal) && !done.length) { this.onGoal(args, this.currentKind); done.push(args) }
      text = text.replace(m[0], '').trim()
    }
    for (const m of [...text.matchAll(/\[remember:\s*(place|note)([^\]]*)\]/gi)]) {
      const args = { kind: m[1].toLowerCase() }
      for (const [, k, v] of m[2].matchAll(/(\w+)=(\S+)/g)) args[k] = v.replace(/_/g, ' ')
      log('memory', this.onRemember(args))
      text = text.replace(m[0], '').trim()
    }
    text = text.replace(/^\(does it\)$/i, '').trim()
    // Remember what he actually did (not tool_calls; providers get picky about tool-message pairing)
    const memory = [text, ...done.map(goalTag)].filter(Boolean).join(' ')
    this.history.push({ role: 'assistant', content: memory || '...' })
    this.memory?.setRecentChat(this.history)
    if (this.memory && ++this.linesSinceSummary >= 16) { this.linesSinceSummary = 0; this.summarize().catch(e => log('memory', 'summary failed:', e.message)) }
    return cleanForSpeech(text)
  }

  // Every so often, write down what's worth keeping long-term (what he learned, owner's likes, plans, discoveries)
  async summarize () {
    if (this.summarizing || !this.memory) return
    this.summarizing = true
    try {
      const transcript = this.history.slice(-24).map(h => `: ${h.content}`).join('\n')
      const msg = await this.request([
        {
          role: 'system',
          content: 'You keep the long-term memory of a Minecraft AI companion. From the recent conversation, pick up to 3 NEW facts worth ' +
            'remembering for future sessions: things learned (what worked or failed), the owner\'s preferences, plans or promises, ' +
            'important discoveries or locations, running jokes. Skip routine chatter and anything already remembered. ' +
            'Reply with ONLY a JSON array of short strings, e.g. ["owner wants a castle by the lake"], or [] if nothing.'
        },
        { role: 'user', content: `Already remembered:\n${this.memory.notes.join('\n') || '(nothing)'}\n\nRecent conversation:\n${transcript}` }
      ], { tools: false, maxTokens: 200, temperature: 0.3 })
      const text = msg?.content ?? ''
      const notes = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1) || '[]')
      for (const n of notes) if (typeof n === 'string' && n.trim()) log('memory', this.memory.remember('note', null, n.trim()))
    } finally {
      this.summarizing = false
    }
  }

  async request (messages, opts = {}) {
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
      max_tokens: opts.maxTokens ?? 120,
      temperature: opts.temperature ?? 1.0,
      top_p: 0.95
    }
    if (this.useTools && opts.tools !== false) body.tools = [SET_GOAL_TOOL, REMEMBER_TOOL]
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

// Models write the task tag a dozen ways: task=..., , task: "...", under_scores. Normalize to plain words.
export function cleanTask (raw) {
  return String(raw || '')
    .replace(/^[\s,;:"'=]*(task\s*[:=]\s*)?/i, '')
    .replace(/["']+$/, '')
    .replace(/^["']+/, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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
