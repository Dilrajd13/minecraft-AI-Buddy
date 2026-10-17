# Minecraft Buddy

A AI sidekick for Minecraft Java. He joins your world as a real player, fights, mines, follows you, trash-talks everything, talks out loud, hears you through push-to-talk, and takes override commands.

## How it works

- **Mineflayer**: runs on your PC. Connects the bot to your world and handles moving, mining and fighting.
- **Jev** (TypeSafe, via OpenRouter): Picks combat moves a few times a second, only when mobs are near. Simple built-in rules take over when it's off.
- **Gemma 4 26B-A4B** (via OpenRouter, or Ollama locally):Handles his personality, his replies and what task he works on.
- **Parakeet TDT 0.6B v2**: runs on CPU. Turns your voice into text while you hold F8.
- **ElevenLabs**: for voice

## 1. setup

**Needs:** Windows, [Node.js 20+](https://nodejs.org), [Python 3.12](https://www.python.org/downloads/) and Minecraft Java **26.1 or older** (26.2 and newer aren't supported by mineflayer yet).

**Keys:**
use .env.example for template

Open `.env` in Notepad and fill in:
- `OWNER_NAME`: your Minecraft username.
- `OPENROUTER_API_KEY`: from https://openrouter.ai/keys. Load credits, and set the key's credit limit if needed. 
- `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`: on the free plan, use a **Default** voice. Voice Library voices need a paid plan.



The first time you run `start-buddy.bat`, it installs the Node packages, creates the push-to-talk Python env (`.venv-ears`), and downloads the Parakeet speech model (about 460 MB, into `models\`).

**For Your own mic or keybind** create `ears.local.bat` For example:
```
set MIC=2
set KEY=f8
```



## 2. Every time you play
1. Start Minecraft Java, open a world, then **Esc → Open to LAN** (Allow Cheats: ON). Put the port it shows in `.env` as `MC_PORT`.
2. Double-click **`start-buddy.bat`**. It opens the bot and the push-to-talk ears in two windows.
3. Hold **F8**, talk, let go. To stop, close both windows.

## Talking to him
- **Voice:** hold F8. Say "override, ..." to add a behavior rule by voice ("override, you're terrified of chickens").
- **Game chat:** just type. Other players can get his attention by saying his name.
- **Terminal:** type a line to talk to him, or a `!command`.

## Override commands (in chat or terminal)
```
!persona <text>     replace his whole personality     (!persona reset)
!add <rule>         stack an override, e.g. !add only speak in rhymes
!clear / !rules     remove / list overrides
!mute / !unmute     voice off/on
!follow !come !guard !stop
!brain jev|reflex   switch the combat brain live
!say <text>         make him say something
!budget             Jev $ spent, tokens used, voice chars left
```
His default personality lives in [config/persona.md](config/persona.md). Edit for different perosnality

## info
- Jev is called only when something's happening (hostiles within 16 blocks, low health, or you're fighting). When it's calm, the free reflexes run.
- `JEV_MAX_SPEND_PER_SESSION` (default $1) switches to free reflexes once it's reached. `JEV_HZ` sets decisions per second.

