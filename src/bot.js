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

  bot.once('spawn', () => {
    const moves = new Movements(bot)
    moves.allowSprinting = true
    moves.canDig = true
    bot.pathfinder.setMovements(moves)
    log('bot', `spawned as ${bot.username} on ${config.mc.host}:${config.mc.port} (MC ${bot.version})`)
  })
  bot.on('kicked', (reason) => log('bot', 'kicked:', typeof reason === 'string' ? reason : JSON.stringify(reason)))
  bot.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
      log('bot', `No Minecraft world at ${config.mc.host}:${config.mc.port}. Open your world to LAN and put the port it shows in .env as MC_PORT, then restart.`)
    } else log('bot', 'error:', err.message || err.code || String(err))
  })

  return bot
}

export function isHostile (e) {
  if (!e || e.type === 'player') return false
  return e.type === 'hostile' || HOSTILE_NAMES.has(e.name)
}

export function ownerEntity (bot) {
  return config.mc.owner ? bot.players[config.mc.owner]?.entity : undefined
}

export function nearbyHostiles (bot, range = 16) {
  if (!bot.entity) return []
  return Object.values(bot.entities)
    .filter(e => isHostile(e) && e.position.distanceTo(bot.entity.position) <= range)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
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
  const lines = [
    `me: health ${Math.round(bot.health)}/20, food ${Math.round(bot.food)}/20, holding ${held}${hasShield ? ', shield in offhand' : ''}, ${food ? `has food (${food.name})` : 'no food'}`,
    `time: ${timeOfDay(bot)}; in water: ${me.isInWater ? 'yes' : 'no'}`,
    owner
      ? `owner ${config.mc.owner}: ${owner.position.distanceTo(me.position).toFixed(1)} blocks ${relDir(bot, owner.position)}`
      : `owner ${config.mc.owner || '?'}: not visible`,
    `current goal: ${goal?.describe?.() ?? 'idle'}`,
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
  const inv = bot.inventory.items().map(i => `${i.count} ${i.name}`).slice(0, 20).join(', ') || 'empty'
  const players = Object.keys(bot.players).filter(n => n !== bot.username)
  return [
    worldState(bot, goal).text,
    `position: ${p.x.toFixed(0)} ${p.y.toFixed(0)} ${p.z.toFixed(0)}, dimension ${bot.game?.dimension ?? '?'}`,
    `inventory: ${inv}`,
    `players online: ${players.join(', ') || 'none'}`
  ].join('\n')
}
