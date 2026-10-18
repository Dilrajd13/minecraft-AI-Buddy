// Voyager's learned skill library (MineDojo/Voyager, MIT License - see vendor/voyager/LICENSE),
// running on top of this bot's own safe primitives (no straight-down digging, water checks, chat kept quiet).
import fs from 'node:fs'
import path from 'node:path'
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { ROOT, log } from './config.js'
import { resolveBlockIds, findSafeBlock, craftItem as craftSafe, findPrey, killEntity, isFoodHunt } from './actions.js'
import { mineOre, ORES } from './mining.js'
import { smelt, placeNextToMe } from './containers.js'

const { goals } = pathfinderPkg
const DIR = path.join(ROOT, 'vendor', 'voyager')
const STOP = new Set(['a', 'an', 'the', 'and', 'of', 'to', 'with', 'me', 'my', 'some', 'get', 'make', 'go', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'ten'])

let cache = null
// { name: { code, summary } } merged from all three Voyager runs (first version of each name wins)
export function voyagerSkills () {
  if (cache) return cache
  cache = {}
  if (!fs.existsSync(DIR)) return cache
  for (const f of fs.readdirSync(DIR).filter(f => /^trial\d+\.json$/.test(f)).sort()) {
    const data = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
    for (const [name, v] of Object.entries(data)) {
      if (cache[name] || !v?.code) continue
      const summary = (v.description || '').replace(/^[\s\S]*?\/\/\s*/, '').replace(/\s*\}\s*$/, '').replace(/\s+/g, ' ').trim()
      cache[name] = { code: v.code, summary: summary.split(/(?<=\.)\s/)[0] || name }
    }
  }
  return cache
}

const words = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
  .filter(w => w && !STOP.has(w)).map(w => w.replace(/(ies)$/, 'y').replace(/([^s])s$/, '$1'))

// Voyager skills that look related to a task (by name + description)
export function searchVoyager (task, limit = 12) {
  const want = new Set(words(task))
  if (!want.size) return []
  return Object.entries(voyagerSkills())
    .map(([name, s]) => {
      const have = new Set(words(`${name} ${s.summary}`))
      const nameHave = new Set(words(name))
      const hits = [...want].filter(w => have.has(w)).length + [...want].filter(w => nameHave.has(w)).length
      return { name, summary: s.summary, score: hits / (want.size * 2) }
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// Same names/signatures Voyager's skills expect, implemented with this bot's safe helpers
export function voyagerPrimitives (bot, { memory, cancelled = () => false, place } = {}) {
  const check = () => { if (cancelled()) throw new Error('cancelled') }
  return {
    async mineBlock (_bot, name, count = 1) {
      check()
      const ore = String(name).replace(/^deepslate_/, '').replace(/_ore$/, '')
      if (ORES.includes(ore)) return mineOre(bot, memory, ore, count, cancelled)
      const ids = resolveBlockIds(bot, name)
      if (!ids.length) throw new Error(`no block called ${name}`)
      for (let i = 0; i < count; i++) {
        check()
        const b = findSafeBlock(bot, ids)
        if (!b) throw new Error(`No ${name} nearby, please explore first`)
        await bot.collectBlock.collect(b)
      }
    },
    // Voyager's count = times to run the recipe; ours = number of items
    async craftItem (_bot, name, count = 1) {
      check()
      const item = bot.registry.itemsByName[name]
      const per = item ? (bot.recipesAll(item.id, null, true)[0]?.result?.count ?? 1) : 1
      return craftSafe(bot, name, count * per)
    },
    async placeItem (_bot, name, position) {
      check()
      try {
        if (place && position) return await place(name, Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
      } catch (err) { log('voyager', `exact spot failed (${err.message}), placing next to me`) }
      return placeNextToMe(bot, name)
    },
    async smeltItem (_bot, itemName, _fuelName, count = 1) { check(); return smelt(bot, itemName, count) },
    async killMob (_bot, mobName, _timeout) {
      check()
      const t = findPrey(bot, mobName) ?? (isFoodHunt(mobName) ? findPrey(bot, 'food') : null)
      if (!t) throw new Error(`No ${mobName} nearby, please explore first`)
      await killEntity(bot, t, cancelled)
    },
    // Walk roughly in a direction until callback() finds something (or time runs out). Never digs down.
    async exploreUntil (_bot, direction, maxTime = 60, callback = () => null) {
      const until = Date.now() + Math.min(maxTime, 120) * 1000
      let dx = Math.sign(direction?.x || 0); let dz = Math.sign(direction?.z || 0)
      if (!dx && !dz) { dx = Math.random() < 0.5 ? 1 : -1; dz = Math.random() < 0.5 ? 1 : -1 }
      while (Date.now() < until) {
        check()
        const found = callback()
        if (found) return found
        const p = bot.entity.position
        const goal = new goals.GoalXZ(Math.floor(p.x + dx * 16), Math.floor(p.z + dz * 16))
        await Promise.race([
          bot.pathfinder.goto(goal).catch(() => { dx = -dz || 1; dz = dx === 1 ? 0 : 1 }), // blocked: turn
          new Promise(resolve => setTimeout(resolve, 10000))
        ])
      }
      return callback() || null
    },
    async getItemFromChest (_bot, chestPosition, itemsToGet) {
      check()
      const block = bot.blockAt(chestPosition)
      await bot.pathfinder.goto(new goals.GoalNear(chestPosition.x, chestPosition.y, chestPosition.z, 2))
      const chest = await bot.openContainer(block)
      try {
        for (const [name, count] of Object.entries(itemsToGet)) {
          const it = chest.containerItems().find(i => i.name === name)
          if (it) await chest.withdraw(it.type, null, Math.min(count, it.count))
        }
      } finally { chest.close() }
    },
    async depositItemIntoChest (_bot, chestPosition, itemsToDeposit) {
      check()
      const block = bot.blockAt(chestPosition)
      await bot.pathfinder.goto(new goals.GoalNear(chestPosition.x, chestPosition.y, chestPosition.z, 2))
      const chest = await bot.openContainer(block)
      try {
        for (const [name, count] of Object.entries(itemsToDeposit)) {
          const it = bot.inventory.items().find(i => i.name === name)
          if (it) await chest.deposit(it.type, null, Math.min(count, it.count))
        }
      } finally { chest.close() }
    },
    async checkItemInsideChest (_bot, chestPosition) {
      const block = bot.blockAt(chestPosition)
      await bot.pathfinder.goto(new goals.GoalNear(chestPosition.x, chestPosition.y, chestPosition.z, 2))
      const chest = await bot.openContainer(block)
      try { log('voyager', 'chest has: ' + chest.containerItems().map(i => `${i.count} ${i.name}`).join(', ')) } finally { chest.close() }
    },
    async shoot () { throw new Error('shooting is not supported') },
    async waitForMobRemoved () {},
    async givePlacedItemBack () {},
    mcData: bot.registry,
    Vec3,
    ...goals
  }
}

// Voyager's skills chat after every step ("Collected cobblestone.") - send that to the log instead of game chat
export function quietBot (bot) {
  return new Proxy(bot, {
    get (target, prop) {
      if (prop === 'chat') return (msg) => log('voyager', msg)
      if (prop === 'save') return () => {}
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
}

// All Voyager skill functions as one script, to define them inside a task's sandbox
export function voyagerScript () {
  return Object.values(voyagerSkills()).map(s => s.code).join('\n\n')
}

// Ask Jev whether one of Voyager's skills does exactly what was asked ("make an iron pickaxe" -> craftIronPickaxe)
export async function pickVoyager (task, jev) {
  if (!jev?.enabled) return null
  const shortlist = searchVoyager(task, 12)
  if (!shortlist.length) return null
  const criteria = Object.fromEntries(shortlist.map((s, i) => [`v${i}`, `${s.name}: ${s.summary}`]))
  criteria.none = 'none of these does what was asked'
  const answers = await jev.ask(`A Minecraft bot was asked: "${task}"\nThese are ready-made programs it could run.`, {
    match: { type: 'choice', instructions: 'Which program accomplishes the request as-is? Pick none if it would do something different or only part of it.', criteria }
  }, { emit: () => {} }).catch(() => null)
  const a = answers?.match
  if (!a?.choice || a.choice === 'none' || !criteria[a.choice]) return null
  const s = shortlist[Number(a.choice.slice(1))]
  log('task', `Jev matched "${task}" to Voyager skill ${s.name} (conf ${Number(a.confidence ?? 0).toFixed(2)})`)
  return { name: s.name, confidence: Number(a.confidence ?? 0) }
}
