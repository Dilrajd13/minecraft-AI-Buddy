import { config } from './config.js'
import { isHostile, ownerEntity } from './bot.js'

// Watches the game and pokes the talk brain so he reacts without being spoken to.
// Rate-limited so he doesn't narrate every single arrow.
export function watchEvents (bot, app) {
  const lastByType = {}
  let lastAny = 0
  const state = { ownerHurtAt: 0, wasNight: false, lastChatAt: Date.now() }

  const fire = (type, text, { cooldown = 30000, urgent = false } = {}) => {
    const now = Date.now()
    if (!urgent && (now - lastAny < 10000 || now - (lastByType[type] ?? 0) < cooldown)) return
    lastAny = now
    lastByType[type] = now
    app.talk.hear('event', text)
  }

  bot.on('entityHurt', (e) => {
    if (e === bot.entity) {
      if (bot.health <= 6) fire('low_hp', `You're badly hurt: ${Math.round(bot.health)}/20 health.`, { cooldown: 20000 })
      else fire('hurt', `You just took damage (${Math.round(bot.health)}/20 health).`, { cooldown: 45000 })
    } else if (e === ownerEntity(bot)) {
      state.ownerHurtAt = Date.now()
      fire('owner_hurt', `${config.mc.owner} just took damage.`, { cooldown: 40000 })
    }
  })

  bot.on('death', () => fire('death', 'You just DIED. React dramatically.', { urgent: true }))

  bot.on('entityDead', (e) => {
    if (e.username && e.username === config.mc.owner) {
      fire('owner_died', `${config.mc.owner} just died. Roast them for it.`, { urgent: true })
    } else if (isHostile(e) && e.position.distanceTo(bot.entity.position) < 6) {
      fire('kill', `A ${e.name} near you just died (probably you killed it).`, { cooldown: 25000 })
    }
  })

  bot.on('playerCollect', (collector, itemEntity) => {
    if (collector !== bot.entity) return
    const item = itemEntity.getDroppedItem?.()
    if (item && /diamond|emerald|netherite|ancient_debris|enchanted_golden/.test(item.name)) {
      fire('loot', `You just picked up ${item.count} ${item.name}!`, { urgent: true })
    }
  })

  bot.on('chat', () => { state.lastChatAt = Date.now() })

  const timer = setInterval(() => {
    if (!bot.entity) return
    const creeper = Object.values(bot.entities).find(e =>
      e.name === 'creeper' && e.position.distanceTo(bot.entity.position) < 5)
    if (creeper) fire('creeper', 'A creeper is right next to you!', { cooldown: 30000 })

    const night = (bot.time?.timeOfDay ?? 0) > 13000 && bot.time.timeOfDay < 23000
    if (night && !state.wasNight) fire('night', 'Night just fell. Mobs are coming out.', { cooldown: 60000 })
    state.wasNight = night

    // Random banter when it's been quiet for a while
    if (Date.now() - state.lastChatAt > 4 * 60000) {
      state.lastChatAt = Date.now()
      fire('bored', 'Nothing has happened for a few minutes. Say something random, rude or funny to your owner.', { cooldown: 0 })
    }
  }, 1000)

  bot.once('end', () => clearInterval(timer))
  return { fire, state }
}
