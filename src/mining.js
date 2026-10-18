import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { log } from './config.js'
import { resolveBlockIds, findSafeBlock, craftItem } from './actions.js'

const { GoalNear } = pathfinderPkg.goals
const danger = (n) => n && /lava|water/.test(n)
const isAir = (b) => !b || /^(air|cave_air|void_air)$/.test(b.name)

// Safe way down: one step forward + one down each time with headroom; stops at lava, water and open caves.
// Continues his existing staircase (remembered as the place "mine"); pass { fresh: true } to start a new one.
export async function staircase (bot, memory, depth = 10, opts = {}, cancelled = () => false) {
  let start, dx, dz
  const mine = memory?.places?.mine
  const me = bot.entity.position
  const sameWorld = !mine?.dimension || mine.dimension === bot.game?.dimension
  if (mine && mine.dx !== undefined && sameWorld && !opts.fresh && Math.hypot(mine.x - me.x, mine.z - me.z) < 96) {
    if (me.distanceTo(new Vec3(mine.x + 0.5, mine.y, mine.z + 0.5)) > 1.5) {
      log('task', `continuing the staircase at ${mine.x} ${mine.y} ${mine.z}`)
      await bot.pathfinder.goto(new GoalNear(mine.x, mine.y, mine.z, 0))
    }
    start = new Vec3(mine.x, mine.y, mine.z)
    dx = mine.dx; dz = mine.dz
  } else {
    start = me.floored()
    const yaw = bot.entity.yaw
    dx = Math.round(-Math.sin(yaw)); dz = dx === 0 ? Math.round(-Math.cos(yaw)) || 1 : 0
  }
  const saveSpot = (x, y, z) => memory?.remember('place', 'mine', null, { x, y, z, dx, dz, dimension: bot.game?.dimension })
  let steps = 0
  for (let i = 1; i <= Math.min(depth, 40); i++) {
    if (cancelled()) throw new Error('cancelled')
    const fx = start.x + dx * i, fy = start.y - i, fz = start.z + dz * i
    if (fy < -58) throw new Error(`stopped the staircase: near bedrock after ${steps} steps`)
    const below = bot.blockAt(new Vec3(fx, fy - 1, fz))
    const around = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([ax, az]) => bot.blockAt(new Vec3(fx + ax, fy, fz + az))?.name)
    if (danger(below?.name) || around.some(danger)) throw new Error(`stopped the staircase: ${below?.name ?? 'liquid'} ahead after ${steps} steps`)
    if (isAir(below)) throw new Error(`stopped the staircase: open cave below after ${steps} steps`)
    for (const y of [fy + 2, fy + 1, fy]) {
      const b = bot.blockAt(new Vec3(fx, y, fz))
      if (!isAir(b)) {
        if (danger(b.name)) throw new Error(`stopped the staircase: ${b.name} after ${steps} steps`)
        try { await bot.tool.equipForBlock(b) } catch {}
        await bot.dig(b)
      }
    }
    if (danger(bot.blockAt(new Vec3(fx, fy + 3, fz))?.name)) throw new Error(`stopped the staircase: water above after ${steps} steps`)
    await bot.pathfinder.goto(new GoalNear(fx, fy, fz, 0))
    steps++
    saveSpot(fx, fy, fz) // so next time he picks up right here
  }
  return steps
}

const ORE_BEST_Y = { coal: 40, iron: 16, copper: 48, gold: -16, redstone: -50, lapis: 0, diamond: -54, emerald: 100 }
const PICK_FOR = { iron: 'stone', copper: 'stone', lapis: 'stone', coal: 'wooden', gold: 'iron', redstone: 'iron', diamond: 'iron', emerald: 'iron' }
const PICKS = ['wooden', 'stone', 'iron', 'diamond', 'netherite']

async function ensurePickFor (bot, ore) {
  const need = PICKS.indexOf(PICK_FOR[ore] ?? 'wooden')
  const have = Math.max(-1, ...bot.inventory.items().filter(i => i.name.endsWith('_pickaxe')).map(i => PICKS.indexOf(i.name.replace('_pickaxe', ''))))
  if (have >= need) return
  // can only make wooden/stone ones here; better ones need iron/diamonds first
  if (need > 1) throw new Error(`I need at least an ${PICK_FOR[ore]} pickaxe to mine ${ore}`)
  if (have < 0) await craftItem(bot, 'wooden_pickaxe', 1)
  if (need === 1) {
    if (!bot.inventory.items().some(i => i.name === 'cobblestone' && i.count >= 3)) {
      const stone = findSafeBlock(bot, resolveBlockIds(bot, 'stone'))
      for (let i = 0; i < 3 && stone; i++) {
        const b = findSafeBlock(bot, resolveBlockIds(bot, 'stone'))
        if (!b) break
        await bot.collectBlock.collect(b)
      }
    }
    await craftItem(bot, 'stone_pickaxe', 1)
  }
}

// "Go get iron": mine visible ore nearby; if there's none, dig the staircase down (toward the ore's best depth)
// and keep looking. Never digs straight down.
export async function mineOre (bot, memory, oreName, count = 3, cancelled = () => false) {
  const ore = String(oreName).toLowerCase().replace(/_ore$|s$/, '').replace(/^deepslate_/, '').replace('diamond', 'diamond')
  const ids = resolveBlockIds(bot, ore)
  if (!ids.length) throw new Error(`I don't know what ${oreName} is`)
  await ensurePickFor(bot, ore)
  let got = 0
  let stairs = 0
  const skip = new Set() // ore he couldn't reach safely this time
  let errors = 0
  while (got < count) {
    if (cancelled()) throw new Error('cancelled')
    const block = findSafeBlock(bot, ids, skip)
    if (block && block.position.distanceTo(bot.entity.position) < 32) {
      // Buried well below him? Walking straight there means digging down. Take the stairs to its level first.
      const below = Math.floor(bot.entity.position.y) - block.position.y
      if (below > 2) {
        log('task', `${ore} is ${below} blocks down, taking the stairs`)
        let steps = 0
        try { steps = await staircase(bot, memory, Math.min(below - 1, 8), {}, cancelled) } catch (err) {
          if (/cancelled/.test(err.message)) throw err
          log('task', err.message)
        }
        stairs += steps
        if (!steps) skip.add(block.position.toString()) // couldn't get down toward that one
        continue
      }
      try {
        try { await bot.tool.equipForBlock(block) } catch {}
        await bot.collectBlock.collect(block)
        got++
      } catch (err) {
        if (/cancelled/.test(err.message)) throw err
        skip.add(block.position.toString())
        log('task', `skipping that ${ore}: ${err.message}`)
        if (++errors >= 6 && !got) throw new Error(`couldn't safely reach any ${ore} (${err.message})`)
      }
      continue
    }
    // none in reach: go down the staircase a bit (only while above the ore's usual depth)
    const targetY = ORE_BEST_Y[ore] ?? 16
    if (bot.entity.position.y <= targetY + 2 && stairs > 0) {
      if (got) break
      throw new Error(`dug down to y ${Math.floor(bot.entity.position.y)} and still found no ${ore}`)
    }
    if (stairs >= 60) break
    log('task', `no ${ore} in sight, taking the stairs down`)
    const steps = await staircase(bot, memory, 6, {}, cancelled)
    stairs += steps
    if (!steps) break
  }
  if (!got) throw new Error(`couldn't find any ${ore}`)
  return `mined ${got} ${ore} ore`
}

export const ORES = Object.keys(ORE_BEST_Y)
