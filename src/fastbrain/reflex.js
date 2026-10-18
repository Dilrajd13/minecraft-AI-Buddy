import { bestFood, ownerEntity } from '../bot.js'

// Free, hand-written reflexes. Used when Jev is off, out of budget, unsure, or when nothing is happening.
export function reflexDecide (bot, state, ctx) {
  const me = bot.entity.position
  const owner = ownerEntity(bot)
  const hs = state.hostiles
  const dist = (e) => e.position.distanceTo(me)
  const near = hs[0]
  const hasFood = !!bestFood(bot)

  if (!near) {
    // eat when hurt, or simply hungry (hunger bar at 14/20 or lower)
    if (hasFood && ((bot.health <= 14 && bot.food < 20) || bot.food <= 14)) return { action: 'eat' }
    return { action: 'pursue_goal' }
  }

  const creeper = hs.find(h => h.name === 'creeper' && dist(h) < 4.5)
  if (creeper) return { action: 'retreat', targetIndex: hs.indexOf(creeper) }

  if (bot.health <= 6 && dist(near) < 6) return { action: 'retreat', targetIndex: 0 }
  if (bot.health <= 10 && hasFood && bot.food < 20 && dist(near) > 6) return { action: 'eat' }

  // Protect the owner: anything within 5 blocks of them gets smacked
  if (owner) {
    const bully = hs.find(h => h.position.distanceTo(owner.position) < 5 && dist(h) < 14)
    if (bully) return { action: 'attack', targetIndex: hs.indexOf(bully) }
  }
  const range = ctx.guarding ? 10 : 5
  if (dist(near) < range && near.name !== 'enderman') return { action: 'attack', targetIndex: 0 }
  return { action: 'pursue_goal' }
}
