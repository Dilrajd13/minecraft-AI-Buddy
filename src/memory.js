import { Vec3 } from 'vec3'
import { readJson, writeJson } from './config.js'

const FILE = 'memory.json'

// Long-term memory that survives restarts: named places, notes about the owner/world,
// and the last few lines of conversation so he picks up where he left off.
export class Memory {
  constructor () {
    const m = readJson(FILE, {})
    this.places = m.places ?? {}
    this.notes = m.notes ?? []
    this.recentChat = m.recentChat ?? []
    this.chests = m.chests ?? {} // "x,y,z" -> { x, y, z, dimension, items: {name: count}, at }
  }

  save () {
    writeJson(FILE, { places: this.places, notes: this.notes, recentChat: this.recentChat, chests: this.chests })
  }

  remember (kind, name, text, where) {
    if (kind === 'place') {
      const key = String(name || text || 'spot').toLowerCase().trim()
      if (!where) return 'no position to remember'
      this.places[key] = where
      this.save()
      return `remembered place "${key}" at ${where.x} ${where.y} ${where.z}`
    }
    const note = String(text || name || '').trim()
    if (!note) return 'nothing to remember'
    this.notes = this.notes.filter(n => n !== note)
    this.notes.push(note)
    if (this.notes.length > 40) this.notes.shift()
    this.save()
    return `noted: ${note}`
  }

  forgetPlace (name) {
    const key = String(name).toLowerCase().trim()
    const had = key in this.places
    delete this.places[key]
    this.save()
    return had
  }

  place (name) {
    const key = String(name || '').toLowerCase().trim()
    return this.places[key] ?? Object.entries(this.places).find(([k]) => k.includes(key) || key.includes(k))?.[1]
  }

  // What's inside each chest he has opened, so "get iron from the chest" goes to the right one
  rememberChest (pos, items, dimension) {
    this.chests[`,${pos.y},${pos.z}`] = { x: pos.x, y: pos.y, z: pos.z, dimension, items, at: Date.now() }
    this.save()
  }

  // Remembered chest (as a block) within reach that holds this item; null if none known
  chestWith (term, bot) {
    if (!term || !bot?.entity) return null
    const me = bot.entity.position
    const hits = Object.entries(this.chests)
      .filter(([, c]) => (!c.dimension || c.dimension === bot.game?.dimension) && Object.keys(c.items).some(n => n === term || n.includes(term)))
      .map(([key, c]) => ({ key, c, d: Math.hypot(c.x - me.x, c.y - me.y, c.z - me.z) }))
      .filter(h => h.d < 96)
      .sort((a, b) => a.d - b.d)
    for (const h of hits) {
      const block = bot.blockAt(new Vec3(h.c.x, h.c.y, h.c.z))
      if (block && /chest|barrel/.test(block.name)) return block
      delete this.chests[h.key] // chest is gone
    }
    return null
  }

  setRecentChat (history) {
    this.recentChat = history.slice(-24)
    this.save()
  }

  // Text block for prompts
  describe () {
    const places = Object.entries(this.places).map(([k, p]) => `- ${k}: ${p.x} ${p.y} ${p.z}${p.dimension ? ` (${p.dimension})` : ''}`)
    return [
      places.length ? `Places you remember:\n${places.join('\n')}` : 'Places you remember: none yet',
      this.notes.length ? `Things you remember:\n${this.notes.map(n => `- ${n}`).join('\n')}` : '',
      Object.keys(this.chests).length ? `Chests you've looked in:\n${Object.values(this.chests).slice(-8).map(c => `- chest at ${c.x} ${c.y} ${c.z}: ${Object.entries(c.items).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, k]) => `${k} ${n}`).join(', ') || 'empty'}`).join('\n')}` : ''
    ].filter(Boolean).join('\n')
  }
}
