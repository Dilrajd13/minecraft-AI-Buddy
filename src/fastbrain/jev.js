import { config, log } from '../config.js'
import { COMBAT_ACTIONS } from '../actions.js'

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'

export const IDLE_ACTIONS = {
  keep_goal: 'nothing needs doing, keep doing my current goal',
  pick_up_items: 'walk over and grab the dropped items nearby (only if there are some)',
  eat: 'eat now while it is safe (only if hungry or hurt and I have food)'
}

// Jev (TypeSafe "System One" model) via OpenRouter: game state + typed questions in,
// calibrated choices out, in one pass. No text generation, so it's fast and cheap.
// Several questions in one call cost the same as one, since you only pay for the input.
export class JevBrain {
  constructor () {
    this.spent = 0
    this.calls = 0
    this.disabledReason = config.openrouterKey ? null : 'no OPENROUTER_API_KEY set'
    this.lastLatencyMs = 0
  }

  get enabled () { return !this.disabledReason }

  async ask (stateText, questions, ctx) {
    if (!this.enabled) return null
    if (this.spent >= config.fast.maxSpend) {
      this.disabledReason = `hit the $${config.fast.maxSpend.toFixed(2)} session cap`
      ctx.emit('jev_off', this.disabledReason)
      return null
    }
    const t0 = Date.now()
    let res
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openrouterKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'minecraft-buddy'
        },
        body: JSON.stringify({ model: config.fast.jevModel, state: stateText, questions }),
        signal: AbortSignal.timeout(2000)
      })
    } catch (err) {
      log('jev', 'request failed:', err.message)
      return null
    }
    this.lastLatencyMs = Date.now() - t0

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      log('jev', `HTTP ${res.status}: ${body.slice(0, 300)}`)
      if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 404) {
        this.disabledReason = res.status === 402 ? 'OpenRouter is out of credit' : `OpenRouter said ${res.status}`
        ctx.emit('jev_off', this.disabledReason)
      }
      return null
    }
    const json = await res.json()
    this.calls++
    this.spent += Number(json?.usage?.cost) || 0
    return json.answers ?? json
  }

  // Combat: best move, which target, and whether it's worth talking about
  async decide (state, ctx) {
    const questions = {
      action: {
        type: 'choice',
        instructions: `You control ${config.mc.botName}, a Minecraft bot whose job is to protect its owner ${config.mc.owner} and survive. ` +
          (ctx.guarding ? 'It is guarding a spot and should attack anything that comes close. ' : '') +
          'Pick the single best move right now. Prefer attack when a hostile is close and health is fine; retreat from creepers about to explode or when health is very low; ' +
          'regroup with the owner when outnumbered or far from them; eat only when safe and hungry or hurt.',
        criteria: COMBAT_ACTIONS
      },
      comment: {
        type: 'noul',
        instructions: 'Is something happening right now that is exciting, scary or funny enough for the bot to say something about it ' +
          '(a big fight, nearly dying, a creeper about to blow, the owner in trouble)? Routine single mobs are not.'
      }
    }
    if (state.hostiles.length > 1) {
      questions.target = {
        type: 'choice',
        instructions: 'Which hostile should the move be aimed at? Usually the closest threat to the owner or the bot.',
        criteria: Object.fromEntries(state.hostiles.map((h, i) => [`t${i}`, `the ${h.name} listed as t${i}`]))
      }
    }

    const answers = await this.ask(state.text, questions, ctx)
    if (!answers) return null
    const a = answers.action
    if (!COMBAT_ACTIONS[a?.choice]) {
      log('jev', 'unexpected response:', JSON.stringify(answers).slice(0, 300))
      return null
    }
    let targetIndex = 0
    const t = answers.target?.choice
    if (typeof t === 'string' && /^t\d+$/.test(t)) targetIndex = Number(t.slice(1))
    return {
      action: a.choice,
      targetIndex,
      confidence: Number(a.confidence ?? 1),
      probs: a.probabilities,
      comment: Number(answers.comment?.noul ?? 0),
      source: 'jev'
    }
  }

  // Calm moments: small chores, decided every few seconds
  async decideIdle (state, ctx) {
    const answers = await this.ask(state.text, {
      chore: {
        type: 'choice',
        instructions: `${config.mc.botName} is a Minecraft bot hanging out with its owner and nothing is attacking. Should it do a small chore right now?`,
        criteria: IDLE_ACTIONS
      }
    }, ctx)
    const c = answers?.chore
    if (!IDLE_ACTIONS[c?.choice]) return null
    return { chore: c.choice, confidence: Number(c.confidence ?? 1) }
  }

  stats () {
    return `Jev: ${this.enabled ? 'on' : `off (${this.disabledReason})`}, ${this.calls} calls, $${this.spent.toFixed(4)} spent this session` +
      (this.calls ? `, ~$${(this.spent / this.calls).toFixed(6)}/call, last ${this.lastLatencyMs}ms` : '')
  }
}
