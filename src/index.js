import http from 'node:http'
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, log, DATA_DIR, recentLogs } from './config.js'
import { createBot, worldState, talkSummary, foodCount } from './bot.js'
import { Body, threatLevel, isFoodHunt, planCtx } from './actions.js'
import { obtain } from './planner.js'
import { reflexDecide } from './fastbrain/reflex.js'
import { JevBrain } from './fastbrain/jev.js'
import { TalkBrain } from './talkbrain.js'
import { Voice } from './tts.js'
import { runCommand, HELP } from './commands.js'
import { watchEvents } from './events.js'
import { Coder } from './coder.js'
import { Memory } from './memory.js'
import { SkillLibrary } from './library.js'
import { buildStructure } from './builder.js'
import { Practice, LADDER } from './practice.js'

// mineflayer-pvp (latest version) still listens for the old 'physicTick' event. Mineflayer still supports it
// and just warns; hide that one warning since it's the library's, not ours.
const rawWarn = console.warn
console.warn = (...a) => { if (!String(a[0]).includes('deprecated event (physicTick)')) rawWarn(...a) }

// One bad promise (a failed dig, a mob vanishing mid-fight) shouldn't kill the whole bot
process.on('unhandledRejection', (err) => log('error', 'unhandled:', err?.stack || String(err)))
process.on('uncaughtException', (err) => log('error', 'uncaught:', err?.stack || String(err)))
process.on('exit', (code) => {
  // appendFile is async, so write this one synchronously or it's lost
  try { fs.appendFileSync(path.join(DATA_DIR, 'buddy.log'), `${new Date().toISOString().slice(0, 10)} [${new Date().toLocaleTimeString()}] [main] bot process exited (code ${code})\n`) } catch {}
})
process.on('SIGINT', () => process.exit(0))
process.on('SIGHUP', () => process.exit(0)) // window closed with the X

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
  coder: null,
  memory: new Memory(),
  library: new SkillLibrary(),
  auto: config.autonomy.on, // decides what to do on his own when nobody's asking
  recentAuto: [],
  lastOwnerAt: 0,
  lastStrangerChatAt: 0,
  speak (text) {
    if (!text) return
    log('say', text)
    app.voice.say(text)
    if (app.bot?.entity) app.bot.chat(text.slice(0, 250))
  }
}

app.talk = new TalkBrain({
  getWorld: () => app.bot ? talkSummary(app.bot, app.body?.goal) : 'not connected',
  onGoal: (args, kind) => {
    if (!app.body) return
    const { goal, ...rest } = args
    // Free-form tasks run AI-written code on this PC, so only the owner may trigger them -
    // or his own initiative, as long as no other player has been chatting at him (they could steer it)
    const strangerQuiet = Date.now() - app.lastStrangerChatAt > 10 * 60000
    if (goal === 'task' && kind !== 'owner' && !(kind === 'self' && strangerQuiet)) {
      log('goal', `ignored task (asked by ${kind}): ${rest.task}`)
      return
    }
    // His own idea to go hunting while his pockets are full of food? Do something else.
    if (kind === 'self' && goal === 'hunt' && isFoodHunt(rest.mob ?? rest.target ?? '') && foodCount(app.bot) >= 6) {
      log('auto', `skipped hunting: already carrying ${foodCount(app.bot)} food`)
      app.talk.hear('event', `You already carry ${foodCount(app.bot)} food, no need to hunt. Pick something else to do.`)
      return
    }
    // A reaction to a game event (got hit, item picked up...) shouldn't cancel a job he's in the middle of.
    // Only the owner (or eating) can interrupt real work.
    if (kind === 'event' && !app.body.goal?.isIdle && !['eat', 'stop'].includes(goal)) {
      log('goal', `kept working on "${app.body.goal.describe()}" instead of ${goal} (that was just a reaction)`)
      return
    }
    if (kind === 'owner') app.lastOwnerAt = Date.now()
    if (kind === 'self') {
      app.recentAuto.push(goal === 'task' ? rest.task : [goal, rest.block, rest.mob, rest.item].filter(Boolean).join(' '))
      if (app.recentAuto.length > 6) app.recentAuto.shift()
      log('auto', `decided to: ${app.recentAuto.at(-1)}`)
    }
    if (goal === 'goto' && rest.place) {
      const p = app.memory.place(rest.place)
      if (!p) return app.talk.hear('event', `You tried to go to "${rest.place}" but you don't remember any place by that name.`)
      Object.assign(rest, { x: p.x, y: p.y, z: p.z })
    }
    app.body.setGoal(goal, rest)
  },
  onReply: (text) => app.speak(text),
  memory: app.memory,
  onRemember: (args) => {
    let where = null
    if (args.kind === 'place' && app.bot?.entity) {
      const p = app.bot.entity.position
      where = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dimension: app.bot.game?.dimension }
    }
    return app.memory.remember(args.kind, args.name, args.text, where)
  }
})

app.coder = new Coder(() => app, app.library, app.memory)
app.practice = new Practice({
  coder: app.coder,
  request: (m) => app.coder.request(m),
  obtain: (bot, item, count, cancelled) => obtain(bot, planCtx(app.body, cancelled), item, count)
})
app.startPractice = () => app.body?.setGoal('practice', { current: () => app.practice.current })

function status (msg) {
  if (!msg) return
  log('cmd', msg)
  if (app.bot?.entity) for (const line of msg.split('\n')) app.bot.whisper(config.mc.owner, line.slice(0, 250))
}

// ---- fast brain loop: reflexes every 200ms, Jev a few times a second only when there's action ----
let jevInFlight = false
let idleInFlight = false
let lastIdleAt = 0
let lastJevAt = 0
let lastLogged = ''

function fastTick () {
  const { bot, body } = app
  if (!bot?.entity || !body) return
  // Drowning beats everything else
  if (body.surfacing) return
  if ((bot.oxygenLevel ?? 20) < 12 && /water/.test(bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name ?? '')) {
    body.surface()
    return
  }
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

  const jevOn = app.fast.mode === 'jev' && app.fast.jev.enabled
  if (!active && jevOn) idleChores(bot, body, state, ctx)
  const useJev = active && jevOn
  if (!useJev) return apply(reflexDecide(bot, state, ctx), 'reflex')
  if (jevInFlight || Date.now() - lastJevAt < 1000 / config.fast.hz) return

  jevInFlight = true
  lastJevAt = Date.now()
  app.fast.jev.decide(state, ctx)
    .then((d) => {
      // Low-confidence or failed call -> trust the hand-written reflexes for this tick
      if (!d || d.confidence < 0.35) apply(reflexDecide(bot, state, ctx), 'reflex')
      else apply(d, `jev ${app.fast.jev.lastLatencyMs}ms`)
      // Jev also decides when a fight is worth talking about
      if (d?.comment > 0.75) app.events?.fire('jev_comment', `This fight is getting intense. Situation:\n${state.text}`, { cooldown: 20000 })
    })
    .finally(() => { jevInFlight = false })
}
setInterval(fastTick, 200)

// Calm moments: ask Jev about small chores, but only when there's actually a choice to make
function idleChores (bot, body, state, ctx) {
  if (idleInFlight || body.mode !== 'goal' || body.pickingUp || Date.now() - lastIdleAt < 5000) return
  // Only when he's just hanging out; never interrupt a job he's in the middle of
  if (!body.goal?.isIdle) return
  const drops = !/dropped items nearby: none/.test(state.text)
  const peckish = (bot.food < 18 || bot.health < 18) && /carrying \d+ food/.test(state.text)
  if (!drops && !peckish) return
  idleInFlight = true
  lastIdleAt = Date.now()
  app.fast.jev.decideIdle(state, ctx)
    .then((d) => {
      if (!d || d.confidence < 0.5 || d.chore === 'keep_goal') return
      log(`jev ${app.fast.jev.lastLatencyMs}ms`, `idle: ${d.chore} conf ${d.confidence.toFixed(2)}`)
      if (d.chore === 'pick_up_items') body.pickUpItems()
      else if (d.chore === 'eat') body.act('eat')
    })
    .finally(() => { idleInFlight = false })
}

// ---- autonomy: when nobody's asking for anything, he picks something to do himself ----
const AUTONOMY_PROMPT = `Nobody has asked you for anything, so pick ONE thing to do right now on your own and call set_goal for it.
Think like a real Minecraft player helping their friend progress:
- Basics first: wood -> crafting table -> wooden pickaxe -> stone tools -> food -> coal + torches -> iron -> iron tools/armor.
- Keep some food (6+) in your inventory but don't hunt if you already have plenty; eat when hungry. Keep your tools upgraded, hunt hostile mobs that get near your owner.
- At night or underground, light things up or build a quick shelter; in the day, gather and explore near the owner.
- Build things when it makes sense (a hut or cabin as a base, a tower to look out, a wall) with set_goal build.
- To get or make any item use set_goal get (e.g. get iron_pickaxe): it works out the tools and materials itself.
- Use 'task' for multi-step jobs (e.g. "make a stone pickaxe and a stone sword", "put torches around the owner").
- Stay within about 30 blocks of your owner. Don't repeat the same activity over and over.
Only say something if it's actually funny or useful, one short line max. Often just act and say nothing.`

let lastAutoAt = 0
function autonomyTick () {
  const { bot, body } = app
  if ((!app.auto && !app.practice.on) || !bot?.entity || !body || app.talk.busy) return
  // Only while just following; "guard" and "stop" mean the owner wants him to stay put
  if (!body.goal?.isIdle || body.goal.isGuard || body.goal.stay || body.mode !== 'goal' || body.pickingUp) return
  const now = Date.now()
  if (now - lastAutoAt < config.autonomy.seconds * 1000 || now - app.lastOwnerAt < 30000) return
  if (threatLevel(bot, body).dist < 12) return // fight first; the fast brain handles that
  lastAutoAt = now
  if (app.practice.on) { app.startPractice(); return } // practice mode: back to the skill ladder
  const recent = app.recentAuto.length ? `\nThings you did recently (do something different unless it's unfinished): ${app.recentAuto.join('; ')}` : ''
  app.talk.hear('self', AUTONOMY_PROMPT + recent)
}
setInterval(autonomyTick, 2000)

// When standing around, look at the owner or whatever's nearby instead of staring into space
let lastLookAt = 0
setInterval(() => {
  const { bot, body } = app
  if (!bot?.entity || !body?.goal?.isIdle || body.mode !== 'goal' || bot.pathfinder?.isMoving?.()) return
  if (Date.now() - lastLookAt < 1500) return
  lastLookAt = Date.now()
  const near = bot.nearestEntity(e => (e.type === 'player' || e.type === 'hostile' || e.type === 'animal' || e.type === 'mob') &&
    e.position.distanceTo(bot.entity.position) < 10)
  const owner = bot.players[config.mc.owner]?.entity
  const target = owner && owner.position.distanceTo(bot.entity.position) < 10 && Math.random() < 0.7 ? owner : near
  if (target) bot.lookAt(target.position.offset(0, target.height ?? 1.6, 0), false).catch(() => {})
}, 500)

// Inventory nearly full while idle: put the extras in a chest (making one, or another one, if needed)
setInterval(() => {
  const { bot, body } = app
  if (!bot?.entity || !body?.goal?.isIdle || body.mode !== 'goal' || body.goal.stay) return
  if (typeof bot.inventory.emptySlotCount === 'function' && bot.inventory.emptySlotCount() < 3) {
    log('goal', 'inventory almost full, tidying up')
    body.setGoal('tidy')
  }
}, 10000)

// If something ever freezes the program (an endless loop), say so in the log instead of silently vanishing
let lastBeat = Date.now()
setInterval(() => {
  const now = Date.now()
  if (now - lastBeat > 4000) log('main', `program was frozen for ${((now - lastBeat) / 1000).toFixed(1)}s`)
  lastBeat = now
}, 1000)

// ---- connect / reconnect ----
function connect () {
  let bot
  try {
    bot = createBot()
  } catch (err) {
    // Never sit there "alive" but disconnected; keep retrying
    log('error', `couldn't start the bot: ${err.stack || err.message}; retrying in 10s`)
    setTimeout(connect, 10000)
    return
  }
  app.bot = bot

  bot.once('spawn', () => {
    app.body = new Body(bot, (type, text) => {
      // practice results: comment now and then, not after every single task
      if (type === 'practice') return app.events?.fire('practice', text, { cooldown: 60000 })
      app.talk.hear('event', type === 'goal_done' ? `You finished: ${text}` : `Something went wrong: ${text}`)
    })
    app.body.runPractice = (cancelled) => app.practice.runOne(bot, cancelled)
    app.body.runTask = (task, cancelled) => app.coder.run(bot, task, cancelled)
    app.body.memory = app.memory
    app.body.runBuild = (structure, material, cancelled) => buildStructure(bot, structure, {
      material, memory: app.memory, cancelled, design: (d) => app.coder.designBlueprint(d)
    })
    app.events = watchEvents(bot, app)
    app.body.setGoal('follow')
    app.talk.hear('event', `You just joined the world. Greet ${config.mc.owner}.`)
  })

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    if (username === config.mc.owner && message.startsWith('!')) return status(runCommand(message, app))
    const mentioned = message.toLowerCase().includes(config.mc.botName.toLowerCase())
    if (username === config.mc.owner) app.talk.hear('owner', `${username} says: ${message}`)
    else if (mentioned) app.lastStrangerChatAt = Date.now()
    if (username !== config.mc.owner && mentioned) app.talk.hear('chat', `${username} (not your owner) says: ${message}`)
  })

  bot.on('end', (reason) => {
    log('bot', `disconnected (${reason}); reconnecting in 5s`)
    app.body = null
    setTimeout(connect, 5000)
  })
}
connect()

// ---- ears: the Python push-to-talk sidecar POSTs what you said here ----
// ---- watch page: http://localhost:<EARS_PORT> shows what he's doing, practice progress, log, skills ----
app.watchPort = config.earsPort
const WATCH_HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'watch.html'), 'utf8')
function watchStatus () {
  const { bot, body } = app
  const me = bot?.entity
  return {
    name: config.mc.botName,
    owner: config.mc.owner,
    online: !!me,
    goal: body?.goal?.describe?.() ?? 'offline',
    plan: body?.plan ?? null,
    freeSlots: typeof bot?.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : null,
    mode: body?.mode ?? '-',
    health: bot?.health ?? 0,
    food: bot?.food ?? 0,
    pos: me ? { x: Math.floor(me.position.x), y: Math.floor(me.position.y), z: Math.floor(me.position.z) } : null,
    inventory: bot?.inventory?.items?.().map(i => ({ name: i.name, count: i.count })) ?? [],
    practice: app.practice.status(),
    ladder: LADDER,
    auto: app.auto,
    skills: app.library.skills.slice().sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, 15).map(s => ({ name: s.name, task: s.task, uses: s.uses, fails: s.fails ?? 0 })),
    skillCount: app.library.skills.length,
    lessons: app.library.lessons.slice(-8).reverse().map(l => l.lesson),
    places: app.memory.places,
    jev: app.fast.jev.stats(),
    log: recentLogs().slice(-80)
  }
}

http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(WATCH_HTML); return
  }
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(watchStatus())); return
  }
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
}).listen(config.earsPort, '127.0.0.1', () => log('ears', `listening for push-to-talk on 127.0.0.1:${config.earsPort}; watch him at http://localhost:${config.earsPort}`))

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
