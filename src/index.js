import http from 'node:http'
import readline from 'node:readline'
import { config, log } from './config.js'
import { createBot, worldState, talkSummary } from './bot.js'
import { Body, threatLevel } from './actions.js'
import { reflexDecide } from './fastbrain/reflex.js'
import { JevBrain } from './fastbrain/jev.js'
import { TalkBrain } from './talkbrain.js'
import { Voice } from './tts.js'
import { runCommand, HELP } from './commands.js'
import { watchEvents } from './events.js'

if (!config.mc.owner || config.mc.owner === 'YourMinecraftName') {
  console.error('Set OWNER_NAME in .env to your Minecraft username first (copy .env.example to .env).')
  process.exit(1)
}

// These survive reconnects; the bot/body get rebuilt each time we join.
const app = {
  bot: null,
  body: null,
  events: null,
  voice: new Voice(),
  fast: { mode: config.fast.brain === 'jev' ? 'jev' : 'reflex', jev: new JevBrain() },
  talk: null,
  speak (text) {
    if (!text) return
    log('say', text)
    app.voice.say(text)
    if (app.bot?.entity) app.bot.chat(text.slice(0, 250))
  }
}

app.talk = new TalkBrain({
  getWorld: () => app.bot ? talkSummary(app.bot, app.body?.goal) : 'not connected',
  onGoal: (args) => {
    if (!app.body) return
    const { goal, ...rest } = args
    app.body.setGoal(goal, rest)
  },
  onReply: (text) => app.speak(text)
})

function status (msg) {
  if (!msg) return
  log('cmd', msg)
  if (app.bot?.entity) for (const line of msg.split('\n')) app.bot.whisper(config.mc.owner, line.slice(0, 250))
}

// ---- fast brain loop: reflexes every 200ms, Jev a few times a second only when there's action ----
let jevInFlight = false
let lastJevAt = 0
let lastLogged = ''

function fastTick () {
  const { bot, body } = app
  if (!bot?.entity || !body) return
  const state = worldState(bot, body.goal)
  const threat = threatLevel(bot, body)
  const ownerFighting = Date.now() - (app.events?.state.ownerHurtAt ?? 0) < 5000
  const active = threat.hostiles.length > 0 || bot.health < 14 || ownerFighting
  const ctx = { guarding: threat.guarding, emit: (type, text) => app.talk.hear('event', `Your combat reflexes brain (Jev) turned off: ${text}`) }

  const apply = (d, source) => {
    if (!d) return
    const target = state.hostiles[d.targetIndex ?? 0]
    const key = `${d.action}:${target?.id ?? ''}`
    if (key !== lastLogged) {
      lastLogged = key
      const extra = d.confidence != null ? ` conf ${d.confidence.toFixed(2)}` : ''
      log(source, `${d.action}${target ? ` -> ${target.name}` : ''}${extra}`)
    }
    body.act(d.action, target)
  }

  const useJev = active && app.fast.mode === 'jev' && app.fast.jev.enabled
  if (!useJev) return apply(reflexDecide(bot, state, ctx), 'reflex')
  if (jevInFlight || Date.now() - lastJevAt < 1000 / config.fast.hz) return

  jevInFlight = true
  lastJevAt = Date.now()
  app.fast.jev.decide(state, ctx)
    .then((d) => {
      // Low-confidence or failed call -> trust the hand-written reflexes for this tick
      if (!d || d.confidence < 0.35) apply(reflexDecide(bot, state, ctx), 'reflex')
      else apply(d, `jev ${app.fast.jev.lastLatencyMs}ms`)
    })
    .finally(() => { jevInFlight = false })
}
setInterval(fastTick, 200)

// ---- connect / reconnect ----
function connect () {
  const bot = createBot()
  app.bot = bot

  bot.once('spawn', () => {
    app.body = new Body(bot, (type, text) => app.talk.hear('event', type === 'goal_done' ? `You finished: ${text}` : `Something went wrong: ${text}`))
    app.events = watchEvents(bot, app)
    app.body.setGoal('follow')
    app.talk.hear('event', `You just joined the world. Greet ${config.mc.owner}.`)
  })

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    if (username === config.mc.owner && message.startsWith('!')) return status(runCommand(message, app))
    const mentioned = message.toLowerCase().includes(config.mc.botName.toLowerCase())
    if (username === config.mc.owner) app.talk.hear('owner', `${username} says: ${message}`)
    else if (mentioned) app.talk.hear('chat', `${username} (not your owner) says: ${message}`)
  })

  bot.on('end', (reason) => {
    log('bot', `disconnected (${reason}); reconnecting in 5s`)
    app.body = null
    setTimeout(connect, 5000)
  })
}
connect()

// ---- ears: the Python push-to-talk sidecar POSTs what you said here ----
http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/heard') { res.writeHead(404).end(); return }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.writeHead(204).end()
    let text = ''
    try { text = String(JSON.parse(body).text || '').trim() } catch { return }
    if (!text) return
    log('heard', text)
    // Say "override ..." to add a behavior rule by voice, e.g. "override, you're scared of chickens"
    const ov = text.match(/^override[,:.]?\s+(.+)/i)
    if (ov) return status(runCommand(`!add ${ov[1]}`, app))
    app.talk.hear('owner', `${config.mc.owner} says (voice): ${text}`)
  })
}).listen(config.earsPort, '127.0.0.1', () => log('ears', `listening for push-to-talk on 127.0.0.1:${config.earsPort}`))

// ---- terminal: type "!commands" or talk to him directly ----
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  line = line.trim()
  if (!line) return
  if (line.startsWith('!')) {
    const out = runCommand(line, app)
    if (out) console.log(out)
  } else {
    app.talk.hear('owner', `${config.mc.owner} says: ${line}`)
  }
})

log('main', `fast brain: ${app.fast.mode}${app.fast.mode === 'jev' && !app.fast.jev.enabled ? ` (Jev unavailable: ${app.fast.jev.disabledReason}, using reflex)` : ''}, ` +
  `talk: ${config.talk.provider}/${config.talk.model}, voice: ${config.tts.provider}`)
console.log('Type in this window to talk to him, or use commands:\n' + HELP.join('\n'))
