import { config, log } from '../config.js'
import { COMBAT_ACTIONS } from '../actions.js'

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'

// Jev (TypeSafe "System One" model) via OpenRouter: game state + typed questions in,
// calibrated choices out, in one pass. No text generation, so it's fast and cheap.
export class JevBrain {
  constructor () {
    this.spent = 0
    this.calls = 0
    this.disabledReason = config.openrouterKey ? null : 'no OPENROUTER_API_KEY set'
    this.lastLatencyMs = 0
  }

  get enabled () { return !this.disabledReason }

  async decide (state, ctx) {
    if (!this.enabled) return null
    if (this.spent >= config.fast.maxSpend) {
      this.disabledReason = `hit the $${config.fast.maxSpend.toFixed(2)} session cap`
      ctx.emit('jev_off', this.disabledReason)
      return null
    }

    const questions = {
      action: {
        type: 'choice',
        instructions: `You control ${config.mc.botName}, a Minecraft bot whose job is to protect its owner ${config.mc.owner} and survive. ` +
          (ctx.guarding ? 'It is guarding a spot and should attack anything that comes close. ' : '') +
          'Pick the single best move right now. Prefer attack when a hostile is close and health is fine; retreat from creepers about to explode or when health is very low; eat only when safe and hungry or hurt.',
        criteria: COMBAT_ACTIONS
      }
    }
    if (state.hostiles.length > 1) {
      questions.target = {
        type: 'choice',
        instructions: 'Which hostile should the move be aimed at? Usually the closest threat to the owner or the bot.',
        criteria: Object.fromEntries(state.hostiles.map((h, i) => [`t${i}`, `the ${h.name} listed as t${i}`]))
      }
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
        body: JSON.stringify({ model: config.fast.jevModel, state: state.text, questions }),
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

    const answers = json.answers ?? json
    const a = answers.action
    const action = a?.choice
    if (!COMBAT_ACTIONS[action]) {
      log('jev', 'unexpected response:', JSON.stringify(json).slice(0, 300))
      return null
    }
    let targetIndex = 0
    const t = answers.target?.choice
    if (typeof t === 'string' && /^t\d+$/.test(t)) targetIndex = Number(t.slice(1))

    return {
      action,
      targetIndex,
      confidence: Number(a.confidence ?? 1),
      probs: a.probabilities,
      source: 'jev'
    }
  }

  stats () {
    return `Jev: ${this.enabled ? 'on' : `off (${this.disabledReason})`}, ${this.calls} calls, $${this.spent.toFixed(4)} spent this session` +
      (this.calls ? `, ~$${(this.spent / this.calls).toFixed(6)}/call, last ${this.lastLatencyMs}ms` : '')
  }
}
