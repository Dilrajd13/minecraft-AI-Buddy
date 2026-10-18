import { listBuilds } from './builder.js'

export const HELP = [
  '!persona <text>  - replace his whole personality (!persona reset = back to default)',
  '!add <rule>      - stack a behavior override, e.g. !add only talk like a pirate',
  '!clear           - remove all overrides',
  '!rules           - list active overrides',
  '!mute / !unmute  - voice off/on (still types in chat)',
  '!follow !come !guard !stop - quick goals without asking nicely',
  '!task <text>     - make him figure out and do anything (he writes his own code for it)',
  '!auto on|off     - let him pick his own things to do when idle (on by default)',
  '!practice on|off|status|reset - practice mode: he trains himself up the skill ladder',
  '!brain jev|reflex - switch the split-second combat brain',
  '!say <text>      - make him say something',
  '!build <name|description> [out of <material>] - build something (see !builds)',
  '!builds          - list blueprints he knows',
  '!skills / !forget <name> - list / delete saved task skills',
  '!lessons / !unlearn <n> - what he has learned from mistakes / delete a bad lesson',
  '!memory          - what he remembers (places + notes)',
  '!remember <fact> - add a note to his memory',
  '!place <name> / !unplace <name> - save / forget the spot he is standing on',
  '!budget          - Jev spend, talk tokens, voice characters left'
]

// Override commands, typed by the owner in Minecraft chat or in the terminal.
// Returns a short status string to show (or null if it wasn't a command).
export function runCommand (line, app) {
  const m = line.trim().match(/^!(\w+)\s*([\s\S]*)$/)
  if (!m) return null
  const [, cmd, rest] = [m[0], m[1].toLowerCase(), m[2].trim()]
  const { talk, voice, body, fast } = app

  switch (cmd) {
    case 'persona':
      if (!rest) return 'usage: !persona <new personality> | !persona reset'
      if (rest === 'reset') { talk.resetPersona(); return 'persona reset to default' }
      talk.setPersona(rest + '\n\nKeep replies to 1-2 short spoken sentences. Use the set_goal tool to act in the game.')
      return 'persona replaced'
    case 'add':
      if (!rest) return 'usage: !add <rule>'
      talk.overrides.push(rest)
      return `override #${talk.overrides.length} added`
    case 'clear':
      talk.overrides = []
      return 'overrides cleared'
    case 'rules':
      return talk.overrides.length ? talk.overrides.map((o, i) => `${i + 1}. ${o}`).join(' | ') : 'no overrides'
    case 'mute': voice.muted = true; return 'voice muted'
    case 'unmute': voice.muted = false; return 'voice on'
    case 'follow': case 'come': case 'guard': case 'stop':
      return body.setGoal(cmd)
    case 'task':
      if (!rest) return 'usage: !task <anything, e.g. build a 5x5 dirt hut here>'
      return body.setGoal('task', { task: rest })
    case 'brain':
      if (rest !== 'jev' && rest !== 'reflex') return `fast brain is ${fast.mode}. usage: !brain jev|reflex`
      fast.mode = rest
      if (rest === 'jev' && !fast.jev.enabled) return `can't use Jev: ${fast.jev.disabledReason}`
      return `fast brain -> ${rest}`
    case 'practice': {
      const p = app.practice
      if (rest === 'on') { p.on = true; app.startPractice(); return `practice mode ON - working up the skill ladder (${p.status().ladderDone}/${p.status().ladderTotal} done). Watch at http://localhost:${app.watchPort}` }
      if (rest === 'off') { p.on = false; body.setGoal('follow'); return 'practice mode OFF' }
      if (rest === 'reset') { p.reset(); return 'practice progress reset (skills and lessons are kept)' }
      const s = p.status()
      return `practice ${s.on ? 'ON' : 'OFF'} | ladder ${s.ladderDone}/${s.ladderTotal} | now: ${s.current ?? '-'} | next: ${s.next}` + (s.gaveUp.length ? ` | gave up on: ${s.gaveUp.join(', ')}` : '')
    }
    case 'auto':
      if (rest === 'on' || rest === 'off') app.auto = rest === 'on'
      else if (rest) return 'usage: !auto on|off'
      return `autonomy is ${app.auto ? 'ON - he picks his own things to do when idle' : 'OFF - he only does what you ask'}`
    case 'builds':
      return 'blueprints: ' + (listBuilds().join(', ') || 'none') + ' (add .schem files to the builds folder)'
    case 'build':
      if (!rest) return 'usage: !build <name or description> [out of <material>]'
      {
        const mm = rest.match(/^(.*?)\s+(?:out of|with|from)\s+(\S+)$/i)
        return body.setGoal('build', mm ? { structure: mm[1], material: mm[2] } : { structure: rest })
      }
    case 'skills':
      return app.library.skills.length ? app.library.list().join('\n') : 'no saved skills yet - they get saved when a !task works'
    case 'forget':
      if (!rest) return 'usage: !forget <skill name>  (see !skills)'
      return app.library.remove(rest) ? `forgot skill ${rest}` : `no skill called ${rest}`
    case 'lessons':
      return app.library.lessons.length ? app.library.lessons.map((l, i) => `. ${l.lesson}`).join('\n') : 'no lessons yet - he writes one when a task only works after failing'
    case 'unlearn': {
      const n = Number(rest)
      if (!n || !app.library.lessons[n - 1]) return 'usage: !unlearn <number from !lessons>'
      const [gone] = app.library.lessons.splice(n - 1, 1)
      app.library.saveLessons()
      return `forgot lesson: ${gone.lesson}`
    }
    case 'memory':
      return app.memory.describe()
    case 'remember':
      if (!rest) return 'usage: !remember <fact>'
      return app.memory.remember('note', null, rest)
    case 'place': {
      if (!rest) return 'usage: !place <name>  (saves where the bot is standing)'
      const p = app.bot?.entity?.position
      if (!p) return 'bot is not in the world'
      return app.memory.remember('place', rest, null, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dimension: app.bot.game?.dimension })
    }
    case 'unplace':
      if (!rest) return 'usage: !unplace <name>'
      return app.memory.forgetPlace(rest) ? `forgot place ${rest}` : `no place called ${rest}`
    case 'say':
      app.speak(rest)
      return null
    case 'budget':
      return [fast.jev.stats(), `talk: ${talk.tokens.in} in / ${talk.tokens.out} out tokens`, voice.stats()].join(' | ')
    case 'help':
      return HELP.join('\n')
    default:
      return `unknown command !${cmd} (try !help)`
  }
}
