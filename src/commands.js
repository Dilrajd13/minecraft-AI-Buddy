export const HELP = [
  '!persona <text>  - replace his whole personality (!persona reset = back to default)',
  '!add <rule>      - stack a behavior override, e.g. !add only talk like a pirate',
  '!clear           - remove all overrides',
  '!rules           - list active overrides',
  '!mute / !unmute  - voice off/on (still types in chat)',
  '!follow !come !guard !stop - quick goals without asking nicely',
  '!brain jev|reflex - switch the split-second combat brain',
  '!say <text>      - make him say something',
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
    case 'brain':
      if (rest !== 'jev' && rest !== 'reflex') return `fast brain is ${fast.mode}. usage: !brain jev|reflex`
      fast.mode = rest
      if (rest === 'jev' && !fast.jev.enabled) return `can't use Jev: ${fast.jev.disabledReason}`
      return `fast brain -> ${rest}`
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
