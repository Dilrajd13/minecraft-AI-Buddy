# Minecraft Buddy

A Chasm-style AI sidekick for Minecraft Java. He joins your world as a real player, fights, mines, follows you, trash-talks everything, talks out loud, hears you through push-to-talk, and takes override commands.

| Part | What | Runs on |
|---|---|---|
| Body | mineflayer + pathfinder / pvp / collectblock | your PC |
| Fast brain (combat reflexes) | **Jev** (TypeSafe System One) via OpenRouter; free coded reflexes as fallback | cloud, ~3 calls/sec only while fighting |
| Talk brain (personality) | **Gemma 4 12B** via OpenRouter (or local Ollama) | cloud / your PC |
| Ears | **Parakeet-TDT-0.6B-v2** int8, push-to-talk | your CPU |
| Voice | ElevenLabs free tier, Piper offline fallback | cloud / your PC |

## 1. One-time setup

**Needs:** Windows, [Node.js 20+](https://nodejs.org), [Python 3.12](https://www.python.org/downloads/) (3.14 is too new for the audio packages), and Minecraft Java **26.1 or older** (26.2 and newer aren't supported by mineflayer yet).

**Keys:**
```bash
copy .env.example .env
```
Open `.env` in Notepad and fill in:
- `OWNER_NAME`: your Minecraft username.
- `OPENROUTER_API_KEY`: from https://openrouter.ai/keys. Load about **$10 prepaid credit**, and set the key's credit limit to 10. **A $0 limit blocks everything.**
- `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`: on the free plan, use a **Default** voice or one you made with **Voice Design**. Voice Library voices need a paid plan.

Only use openrouter.ai or TypeSafe's own `console.typesafe.ai` for Jev. Sites like jev-ai.org or jevplayground.com aren't official, so never give them a key.

That's it. The first time you run `start-buddy.bat`, it installs the Node packages, creates the push-to-talk Python env (`.venv-ears`), and downloads the Parakeet speech model (about 460 MB, into `models\`).

**Your own mic or paths:** create `ears.local.bat` next to `start-ears.bat`. It's gitignored. For example:
```
set MIC=2
set KEY=f8
```
The mic numbers are printed when the ears window starts. You can also set `EARS_VENV` or `PARAKEET_DIR` to reuse an env or model you already have.

**Optional free voice (Piper)**: download `piper_windows_amd64.zip` from https://github.com/rhasspy/piper/releases and a voice `.onnx` + `.onnx.json` (e.g. `en_US-ryan-high`). Set `PIPER_EXE` and `PIPER_MODEL`. He uses Piper automatically when your ElevenLabs characters run low.

## 2. Every time you play
1. Start Minecraft Java, open a world, then **Esc → Open to LAN** (Allow Cheats: ON). Put the port it shows in `.env` as `MC_PORT`.
2. Double-click **`start-buddy.bat`**. It opens the bot and the push-to-talk ears in two windows.
3. Hold **F8**, talk, let go. To stop, close both windows.

## Talking to him
- **Voice:** hold F8. Say "override, ..." to add a behavior rule by voice ("override, you're terrified of chickens").
- **Game chat:** just type. Other players can get his attention by saying his name.
- **Terminal:** type a line to talk to him, or a `!command`.

## Override commands (you only, in chat or terminal)
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
His default personality lives in [config/persona.md](config/persona.md). Edit it to taste.

## Keeping it cheap (under $20)
- Jev is called only when something's happening (hostiles within 16 blocks, low health, or you're fighting). When it's calm, the free reflexes run.
- `JEV_MAX_SPEND_PER_SESSION` (default $1) switches to free reflexes once it's reached. `JEV_HZ` sets decisions per second.
- `!budget` shows the real cost per call reported by OpenRouter. Check it after your first fight and adjust `JEV_HZ`.
- `FAST_BRAIN=reflex` plus `TALK_PROVIDER=ollama` costs $0. Run `ollama pull` for a Gemma 4 12B build, set `OLLAMA_MODELS=W:\ollama` so it doesn't fill C:, and expect replies to take a few seconds on a 6 GB GPU.

## Want him less filtered?
Point `TALK_PROVIDER=ollama` at a community "abliterated" or uncensored Gemma build from Hugging Face. Set `TALK_MODEL` to the Ollama tag.

## Keeping your keys safe
- Your keys go **only** in `.env`. That file is in `.gitignore`, so it never gets uploaded.
- After cloning, run `git config core.hooksPath .githooks`. That turns on a check that blocks any commit containing a `.env` file or something that looks like an API key.
- If a key ever leaks, **delete it right away** on openrouter.ai/settings/keys or in ElevenLabs, and make a new one. Deleting the file from GitHub isn't enough, because it stays in the history.

## Troubleshooting
- **Bot can't join:** check `MC_PORT` matches the LAN port. Servers must have `online-mode=false`, because the bot logs in offline.
- **"model has no tool calling here, switching to text goals":** this is fine. He then picks goals with `[goal: ...]` tags in his reply.
- **Jev turned off:** the log says why (no key, out of credit, or session cap). He keeps fighting with reflexes.
- `npm run check` runs the offline self-test.
