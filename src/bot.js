import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import pvpPkg from 'mineflayer-pvp'
import collectPkg from 'mineflayer-collectblock'
import { config, log } from './config.js'

const { pathfinder, Movements } = pathfinderPkg

// Fallback list in case the server's entity data doesn't tag mobs as "hostile"
const HOSTILE_NAMES = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'creeper', 'spider',
  'cave_spider', 'witch', 'enderman', 'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator',
  'evoker', 'ravager', 'blaze', 'ghast', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin',
  'silverfish', 'endermite', 'guardian', 'elder_guardian', 'vex', 'breeze', 'warden', 'shulker'
])

export const FOODS = [
  'golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_salmon', 'cooked_chicken',
  'cooked_cod', 'cooked_rabbit', 'baked_potato', 'bread', 'golden_apple', 'apple', 'carrot', 'melon_slice',
  'sweet_berries', 'cookie', 'pumpkin_pie', 'beef', 'porkchop', 'mutton', 'chicken', 'potato'
]

export function createBot () {
  const bot = mineflayer.createBot({
    host: config.mc.host,
    port: config.mc.port,
    username: config.mc.botName,
    version: config.mc.version,
    auth: 'offline' // LAN worlds / offline-mode servers; no second Microsoft account needed
  })

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(pvpPkg.plugin)
  bot.loadPlugin(collectPkg.plugin)

  // The server KICKS players who hit items, XP orbs, arrows or themselves. Block that at the source,
  // so no plugin, brain or AI-written task code can ever get him kicked this way.
  // (bot.attack only exists once mineflayer has finished loading, so wrap it at login)
  bot.once('login', () => {
    if (typeof bot.attack !== 'function' || bot.attack.guarded) return
    const rawAttack = bot.attack.bind(bot)
    bot.attack = (target, ...rest) => {
      if (!isAttackable(bot, target)) {
        log('bot', `refused to attack ${target?.name ?? 'nothing'} (not a valid target)`)
        try { bot.pvp?.stop() } catch {}
        return
      }
      return rawAttack(target, ...rest)
    }
    bot.attack.guarded = true
  })

  // Digging guard: never break the block under his own feet (that's how you fall into lava/caves),
  // and never break a block with water or lava behind/above it (that's how you drown).
  bot.once('login', () => {
    if (typeof bot.dig !== 'function' || bot.dig.guarded) return
    const rawDig = bot.dig.bind(bot)
    let lastRefusalLog = 0
    let recentRefusals = []
    const refuse = (msg, err) => {
      if (Date.now() - lastRefusalLog > 5000) { log('bot', msg); lastRefusalLog = Date.now() } // don't spam the log
      // Something keeps retrying the same unsafe dig (stuck in a loop): cancel it instead of freezing in place
      const now = Date.now()
      recentRefusals = recentRefusals.filter(t => now - t < 4000)
      recentRefusals.push(now)
      if (recentRefusals.length >= 8) {
        recentRefusals = []
        log('bot', 'kept getting asked to dig unsafely; cancelling that path')
        try { bot.pathfinder.stop() } catch {}
        try { bot.collectBlock?.cancelTask() } catch {}
      }
      return Promise.reject(new Error(err))
    }
    bot.dig = (block, ...rest) => {
      if (block && bot.entity) {
        // "Straight down" = the block his body is centered over. Near a block edge (mid-step) the pathfinder's
        // diagonal step-downs only look like that, so those are allowed; everything centered underneath is refused.
        const p = bot.entity.position
        const under = block.position.y === Math.floor(p.y) - 1 &&
          Math.abs(block.position.x + 0.5 - p.x) < 0.3 && Math.abs(block.position.z + 0.5 - p.z) < 0.3
        if (under) return refuse('refused to dig straight down', "won't dig straight down under myself (use stairs)")
        if (touchesLiquid(bot, block.position)) {
          return refuse(`refused to dig ${block.name}: water/lava behind it`, `won't dig that ${block.name}, there's water or lava behind it`)
        }
        const below = bot.blockAt(block.position.offset(0, -1, 0))
        if (below && /lava/.test(below.name)) return refuse(`refused to dig ${block.name}: lava under it`, `won't dig that ${block.name}, there's lava under it`)
      }
      return rawDig(block, ...rest)
    }
    bot.dig.guarded = true
  })

  bot.once('spawn', () => {
    const moves = new SafeMovements(bot)
    moves.allowSprinting = true
    moves.canDig = true
    moves.liquidCost = 10 // walk around water instead of swimming through it
    // While fighting: chase on foot only, never dig toward a mob
    const combat = new SafeMovements(bot)
    combat.allowSprinting = true
    combat.canDig = false
    combat.liquidCost = 10
    bot.buddyMoves = { normal: moves, combat }
    bot.pathfinder.setMovements(moves)
    // Safe routes (stairs instead of holes) take longer to work out; default 5s often gave up on mining trips
    bot.pathfinder.thinkTimeout = 15000
    bot.pathfinder.tickTimeout = 40
    // mineflayer-collectblock installs its OWN default movements on every collect (straight-down digging allowed,
    // water-flow protection switched off). Give it a safe set instead, so mining can't dig down or flood him.
    const collectMoves = new SafeMovements(bot)
    collectMoves.allowSprinting = true
    collectMoves.canDig = true
    collectMoves.liquidCost = 10
    if (bot.collectBlock) bot.collectBlock.movements = collectMoves
    log('bot', `spawned as ${bot.username} on ${config.mc.host}:${config.mc.port} (MC ${bot.version})`)
  })
  bot.on('kicked', (reason) => log('bot', 'kicked:', typeof reason === 'string' ? reason : JSON.stringify(reason)))
  bot.on('death', () => {
    const p = bot.entity?.position
    log('bot', `died${p ? ` at ${p.x.toFixed(0)} ${p.y.toFixed(0)} ${p.z.toFixed(0)}` : ''}`)
  })
  bot.on('respawn', () => log('bot', 'respawned'))
  bot.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
      log('bot', `No Minecraft world at ${config.mc.host}:${config.mc.port}. Open your world to LAN and put the port it shows in .env as MC_PORT, then restart.`)
    } else log('bot', 'error:', err.message || err.code || String(err))
  })

  return bot
}

// Pathfinding rules with two fixes: never plan to dig straight down, never break blocks next to water/lava
class SafeMovements extends Movements {
  getMoveDown (node, neighbors) {
    if (!this.getBlock(node, 0, -1, 0).safe) return // would have to dig the floor out from under himself
    super.getMoveDown(node, neighbors)
  }

  safeToBreak (block) {
    if (!super.safeToBreak(block)) return false
    return !touchesLiquid(this.bot, block.position)
  }
}

const LIQUID = /water|lava|bubble_column/
// Water/lava above or beside this spot (it would pour in if the block were removed)
export function touchesLiquid (bot, pos) {
  for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = bot.blockAt(pos.offset(dx, dy, dz))
    if (b && LIQUID.test(b.name)) return true
  }
  return false
}

// Clear line of sight from his eyes to the mob (no solid blocks in between)
export function canSee (bot, e) {
  if (!bot.entity || !e) return false
  const from = bot.entity.position.offset(0, 1.62, 0)
  const to = e.position.offset(0, (e.height ?? 1.8) * 0.8, 0)
  const dist = from.distanceTo(to)
  const steps = Math.ceil(dist / 0.3)
  for (let i = 1; i < steps; i++) {
    const p = from.plus(to.minus(from).scaled(i / steps))
    const b = bot.blockAt(p)
    if (b && b.boundingBox === 'block' && !/glass|leaves|fence|bars/.test(b.name)) return false
  }
  return true
}

const NOT_CREATURE_TYPES = new Set(['object', 'orb', 'projectile', 'global', 'other'])
const UNHITTABLE = /^(item|experience_orb|.*arrow|trident|snowball|egg|ender_pearl|.*fireball|wind_charge|potion|experience_bottle|fishing_bobber|area_effect_cloud|marker|lightning_bolt|falling_block|tnt|eye_of_ender|firework_rocket|llama_spit|shulker_bullet|evoker_fangs|interaction|.*_display)$/

// Living mobs/players only; never items, orbs, projectiles, or himself
export function isAttackable (bot, e) {
  if (!e || e === bot.entity || e.id === bot.entity?.id) return false
  if (!bot.entities[e.id]) return false // already gone/dead
  if (NOT_CREATURE_TYPES.has(e.type)) return false
  if (e.name && UNHITTABLE.test(e.name)) return false
  return true
}

// A living mob of this kind (exact name, or close: "cows" -> cow, "skelly" no)
export function isMobNamed (e, term) {
  if (!e || e.type === 'player' || NOT_CREATURE_TYPES.has(e.type) || !e.name || UNHITTABLE.test(e.name)) return false
  return e.name === term || e.name === term.replace(/s$/, '') || e.name.endsWith('_' + term)
}

export const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']

export function isHostile (e) {
  if (!e || e.type === 'player') return false
  return e.type === 'hostile' || HOSTILE_NAMES.has(e.name)
}

export function ownerEntity (bot) {
  return config.mc.owner ? bot.players[config.mc.owner]?.entity : undefined
}

// Hostiles he can actually see (not ones in caves under his feet). Anything right next to him counts too.
export function nearbyHostiles (bot, range = 16) {
  if (!bot.entity) return []
  const me = bot.entity.position
  return Object.values(bot.entities)
    .filter(e => isHostile(e) && e.position.distanceTo(me) <= range &&
      ((e.position.distanceTo(me) < 2.5 && Math.abs(e.position.y - me.y) < 2) || canSee(bot, e)))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
}

export function foodCount (bot) {
  return bot.inventory.items().filter(i => FOODS.includes(i.name)).reduce((a, i) => a + i.count, 0)
}

export function bestFood (bot) {
  const items = bot.inventory.items()
  for (const name of FOODS) {
    const it = items.find(i => i.name === name)
    if (it) return it
  }
  return null
}

// Compass direction from the bot to a point, relative to where the bot is facing
function relDir (bot, pos) {
  const dx = pos.x - bot.entity.position.x
  const dz = pos.z - bot.entity.position.z
  const angleTo = Math.atan2(-dx, -dz) // mineflayer yaw convention
  let diff = angleTo - bot.entity.yaw
  while (diff > Math.PI) diff -= 2 * Math.PI
  while (diff < -Math.PI) diff += 2 * Math.PI
  const deg = diff * 180 / Math.PI
  if (Math.abs(deg) < 35) return 'ahead'
  if (Math.abs(deg) > 145) return 'behind'
  return deg > 0 ? 'left' : 'right'
}

function timeOfDay (bot) {
  const t = bot.time?.timeOfDay ?? 0
  if (t < 12000) return 'day'
  if (t < 13800) return 'sunset'
  if (t < 22200) return 'night'
  return 'sunrise'
}

// Compact snapshot of the world. Keep it short: it's sent to Jev several times a second.
export function worldState (bot, goal) {
  const me = bot.entity
  if (!me) return { text: 'not spawned', hostiles: [] }
  const hostiles = nearbyHostiles(bot, 16).slice(0, 5)
  const owner = ownerEntity(bot)
  const held = bot.heldItem?.name ?? 'nothing'
  const hasShield = bot.inventory.slots[45]?.name === 'shield'
  const food = bestFood(bot)
  const foodN = foodCount(bot)
  const lines = [
    `me: health ${Math.round(bot.health)}/20, food ${Math.round(bot.food)}/20, holding ${held}${hasShield ? ', shield in offhand' : ''}, ${food ? `carrying ${foodN} food (best: ${food.name})` : 'NO food'}`,
    `time: ${timeOfDay(bot)}; in water: ${me.isInWater ? 'yes' : 'no'}`,
    owner
      ? `owner ${config.mc.owner}: ${owner.position.distanceTo(me.position).toFixed(1)} blocks ${relDir(bot, owner.position)}`
      : `owner ${config.mc.owner || '?'}: not visible`,
    `current goal: ${goal?.describe?.() ?? 'idle'}`,
    (() => {
      const drops = Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(me.position) < 12)
      if (!drops.length) return 'dropped items nearby: none'
      const d = Math.min(...drops.map(e => e.position.distanceTo(me.position)))
      return `dropped items nearby: ${drops.length} (nearest ${d.toFixed(1)} blocks)`
    })(),
    hostiles.length
      ? 'hostiles:\n' + hostiles.map((h, i) =>
        `  t${i}: ${h.name} ${h.position.distanceTo(me.position).toFixed(1)} blocks ${relDir(bot, h.position)}` +
        (owner ? `, ${h.position.distanceTo(owner.position).toFixed(1)} from owner` : '')).join('\n')
      : 'hostiles: none'
  ]
  return { text: lines.join('\n'), hostiles }
}

// Longer, human-friendly summary for the talk brain
export function talkSummary (bot, goal) {
  const me = bot.entity
  if (!me) return 'You are not in the world yet.'
  const p = me.position
  const inv = bot.inventory.items().map(i => `${i.count} ${i.name}`).slice(0, 36).join(', ') || 'EMPTY (nothing at all)'
  const players = Object.keys(bot.players).filter(n => n !== bot.username)
  return [
    worldState(bot, goal).text,
    `position: ${p.x.toFixed(0)} ${p.y.toFixed(0)} ${p.z.toFixed(0)}, dimension ${bot.game?.dimension ?? '?'}`,
    `YOUR INVENTORY (exactly what you carry right now - trust this, not what you think you picked up): ${inv}`,
    `players online: ${players.join(', ') || 'none'}`
  ].join('\n')
}
