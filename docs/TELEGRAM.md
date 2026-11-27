# Jarvis: Telegram bridge

This file is the one place for everything about the Telegram bridge that you need as a user (off by default, turned on with `JARVIS_TELEGRAM`): what it does, how to set it up, every setting, how it behaves, what it protects and where it stops. For the design, invariants and code map see [Telegram bridge](ARCHITECTURE.md#telegram-bridge) in the technical documentation.

## Contents

- [What it does](#what-it-does)
- [Setup](#setup)
- [Configuration](#configuration)
- [Behavior](#behavior)
- [Security](#security)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)

## What it does

Talk to Jarvis from your phone. The bridge is a separate process (`npm run telegram`, or started by Jarvis with `JARVIS_TELEGRAM=1`) that connects a private Telegram group to your local Jarvis:

- Every workspace gets its own **topic** in a private forum supergroup (a group with Topics enabled).
- Jarvis's replies (the text of the arbiter) go to the topic of their workspace.
- What you write in a topic goes to that workspace's Jarvis, as if you typed it in the web UI.
- A 👀 on your message means: the bridge delivered it to Jarvis. It does not mean that the arbiter read or answered it.
- Permission prompts (ALLOW / DENY) stay in the web UI, and so do alerts and the cost lines.
- Write `/help` in the General topic to list the topics.

The bridge talks to Jarvis only through its HTTP API on loopback and to Telegram only outbound. It opens no port, and the Jarvis server does not know it exists.

## Setup

You need a Telegram account and a running Jarvis.

1. **Create the bot.** In Telegram, talk to [@BotFather](https://t.me/BotFather), send `/newbot` and follow the questions. Copy the token it gives you.
2. **Create the group.** Make a new private group, open its settings and enable **Topics** first, then add the bot. Turning Topics on changes the group id (the group becomes a supergroup), so an id found before that is dead. Make the bot an admin with the **Manage Topics** right (the bridge makes the topics). An admin bot sees all messages of the group. A bot that is not an admin sees only commands and replies to it, unless you turn privacy mode off with `/setprivacy` in @BotFather (then remove the bot from the group and add it again); without that `--pair` waits forever on plain text. Add nobody else.
3. **Store the token outside the repo.** Create `~/.config/jarvis/telegram.env` and keep it private:

   ```bash
   mkdir -p ~/.config/jarvis
   install -m 600 /dev/null ~/.config/jarvis/telegram.env
   echo 'TELEGRAM_BOT_TOKEN=<the token>' >> ~/.config/jarvis/telegram.env
   ```

   The bridge does not check the file mode; `600` is up to you.
4. **Find the ids.** Run `npm run telegram -- --pair`. It waits for one message the bot sees: write a message in the group (any topic). If several messages wait, it takes the newest one, a message from a supergroup first. It prints the chat id, the chat type and title, and your sender id with name and username. It forwards nothing and exits. It warns if the chat is not a supergroup or Topics is off in it (turn Topics on, write again and run `--pair` again), if you wrote in a private chat with the bot (write in the group instead) or as an anonymous admin (turn off "remain anonymous" and write again).
5. **Add the ids** to the same file as `TELEGRAM_CHAT_ID=<chat id>` and `TELEGRAM_ALLOWED_USER=<sender id>`. Without both the bridge does not start.
6. **Start it.** Either run `npm run telegram` next to a running Jarvis (stop it with Ctrl-C), or let Jarvis start it (see [Start with Jarvis](#start-with-jarvis)).

### Start with Jarvis

Jarvis starts the bridge itself when you ask for it, like voice input:

- Set `JARVIS_TELEGRAM=1` in the environment or as a line in the Jarvis env file (`~/.config/jarvis/env`). `1` turns it on, like `JARVIS_VOICE`; `0` or unset turns it off; any other value is reported in the log and ignored, and the next source decides (shell, then env file, then off). A variable in the shell wins over the file, so `JARVIS_TELEGRAM=0` switches it off even when the file says `1`. `JARVIS_TELEGRAM` in the env file applies to every Jarvis instance started with that file, so a second instance on another `PORT` or data dir starts its own bridge; that bridge talks to its own Jarvis via `PORT`.
- The bridge runs as a child process with the same settings as `npm run telegram` (`telegram.env`) and stops when Jarvis stops. Its log lines appear in the Jarvis log with the prefix `telegram:`.
- If it cannot start (no token or ids, 401, wrong group), Jarvis logs one line with the reason and keeps running; the bridge is not restarted. If a bridge already runs on the same data dir, Jarvis tries again 3 times, 2 s apart (after `jarvis restart` the old bridge can still hold its lock for a few seconds), and then logs that and starts no second one.

The first start makes a topic for each workspace. Write in a topic and look for the 👀.

## Configuration

All settings are environment variables. The bridge reads `telegram.env` from the folder of the Jarvis env file (`~/.config/jarvis/telegram.env`) and also the Jarvis env file itself. The order is: a variable set in the shell wins, then the Jarvis env file, then `telegram.env` (the bridge loads the Jarvis env file first, and a file never overwrites a variable that is already set).

| Variable | Default | What it does |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | none, required | Token from @BotFather. Never logged. |
| `TELEGRAM_ALLOWED_USER` | none, required (not for `--pair`) | Your numeric Telegram user id. Only this user is obeyed. |
| `TELEGRAM_CHAT_ID` | none, required (not for `--pair`) | Numeric id of the group, usually negative. Only this chat is served. |
| `TELEGRAM_BACKFILL` | `10` | How many of the last messages of a workspace the bridge sends when it sees that workspace for the first time: a number, `0` for none, or `all` for the whole history. Anything else stops the start. |
| `JARVIS_TELEGRAM` | unset (off) | `1` makes Jarvis start the bridge; `0` or unset does not; any other value is reported in the log and ignored, and the next source decides (shell, then env file, then off) (read by Jarvis, not by the bridge). |
| `JARVIS_URL` | `http://127.0.0.1:7777` | Where Jarvis listens. Must be `127.0.0.1`, `localhost` or `[::1]`; set it when Jarvis runs on another `PORT`. |
| `TELEGRAM_ENV_FILE` | `telegram.env` next to the Jarvis env file | Another file to read the settings from. |
| `JARVIS_ENV_FILE` | `$XDG_CONFIG_HOME/jarvis/env`, else `~/.config/jarvis/env` | The Jarvis env file (also read by the bridge). Its folder decides where `telegram.env` is looked for. |
| `XDG_CONFIG_HOME` | `~/.config` | Base folder of the two env files above. |
| `XDG_DATA_HOME` | `~/.local/share` | The state file and its lock live in `$XDG_DATA_HOME/jarvis/`: `telegram-bridge.json` and `telegram-bridge.json.lock`. |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Tests only: points the bridge at a fake Telegram. Must be https, or loopback. |
| `TELEGRAM_STATE_FILE` | `$XDG_DATA_HOME/jarvis/telegram-bridge.json` | Tests only: another state file (the lock is `<state file>.lock`). |

## Behavior

**Topics.** A topic is made for each workspace the bridge sees, named like the workspace (at most 128 characters). The bridge checks the list of workspaces every 10 s, so a new workspace gets its topic within that time. The topic ids are kept in the state file, so a restart reuses the topics and never makes a second one. A renamed workspace keeps its topic name. If you delete a topic in Telegram, the bridge notices at the next send, forgets it and makes a new one at the next check. A workspace that is deleted or archived in Jarvis (missing from the list for 3 checks in a row) loses its entry in the state; its Telegram topic stays.

**What goes to Telegram.** Only the text of the arbiter. Agent-finished notices and other service lines are not sent. Texts of one workspace that come within 1.5 s are merged into one message. Text is sent as plain text, split on line breaks when it is longer than 4096 characters. What you typed yourself, in Telegram or in the web UI, is never repeated in the topic.

**What comes from Telegram.** A text message in a topic goes to the Jarvis of that workspace. After Jarvis accepted it, the bridge puts 👀 on the message. If Jarvis did not accept it, the topic gets "Jarvis did not take the message." and there is no 👀. Messages that are not text (photos, voice, files), edited messages and messages in an unknown topic are ignored. In the General topic only `/help` is answered.

**The 👀 reaction.** It is a separate cheap call, not part of the send queue, and it never delays the message to Jarvis. Reactions go one after another; if more than 20 wait, new ones are skipped. A reaction that fails (for example, the group does not allow 👀 as a reaction) is logged once per kind of error and never retried; the message still reached Jarvis.

**Catch-up.** The bridge keeps for each workspace the time of the last event it handled, in the state file. After a restart or a lost connection it sends what was written meanwhile, in order and without repeating anything: the position is saved before the text is queued, so a crash can lose a message but never sends one twice.

**First run and new workspaces.** A workspace the bridge has not seen before gets only its last `TELEGRAM_BACKFILL` messages (default 10; the count is of what would be sent, not of everything in the log), merged into one text. `all` sends the whole history.

**Send queue.** One queue serves the whole group and sends one message every 3 s, because Telegram allows about 20 messages a minute in a group. Live text always goes first; the history of a new workspace goes only when no live text waits, so a large `all` backfill arrives slowly (minutes or hours) and does not hold back the live replies of other workspaces. The live text of the workspace that still has history waiting goes after that history, so its topic stays in order. Within each of the two, the workspaces take turns, so one noisy workspace does not hold back the others. A send that fails with a rate limit (429), a network error or a server error (5xx) is tried again, waiting what Telegram asks or 1 s, 2 s, 4 s and so on (at most 15 s); a part that still fails after 60 s is dropped and `send failed` is logged.

**Stopping.** Ctrl-C or SIGTERM sends the text that still waits (for at most 5 s), then exits.

**Errors from Telegram.** A wrong token (401) ends the bridge at once with an error. A 409 means another program polls the same bot (or a webhook is set). After a quick restart Telegram still holds the old connection for up to about 50 s, so the bridge waits and retries; only a 409 that lasts 90 s ends it. At start the bridge also exits when the group is not a forum (Topics is off) and when another copy of the bridge already runs on the same data dir.

## Security

Whoever can write to the bot can make Jarvis run commands. The allowlist is the whole protection:

- A message is obeyed only when it comes from `TELEGRAM_ALLOWED_USER` in the chat `TELEGRAM_CHAT_ID`. Anything else is dropped without an answer.
- Messages sent as an anonymous admin (sent in the name of the group), forwarded messages and messages sent through an inline bot are ignored, even from you: they carry text you did not write.
- The bridge refuses to start without both ids.
- Keep the group private, with only the bot and you as members: every member reads all that Jarvis writes there, including the `/help` list of your workspaces.
- The token is a secret. Keep it outside the repo, in a file only you can read. Every log line and error is cleaned of it before it is printed.
- `JARVIS_URL` must be on loopback, and the Telegram address must be https. Otherwise the bridge does not start.
- The state file (topic ids, update position, position per workspace) has mode `0600`. The lock file holds only the process id, with the default file mode.

## Limits

- One user, one group, text only: no voice, files or buttons.
- What waits in the send queue is lost when the bridge crashes or is killed, and when a stop runs out of its 5 s; most of all the rest of a long backfill. It is never sent twice, because its position was saved before it was queued.
- An event whose time is older than the saved position (the clock of the machine went backwards) is not sent.
- Telegram limits a message to 4096 characters (longer text is split) and a group to about 20 messages a minute (the 3 s gap keeps the bridge below it). Many messages in a short time therefore arrive slowly.
- What you type in the web UI is not shown in Telegram.
- Telegram sees all that Jarvis writes in the group: do not use it for text that must not leave your machine.

## Troubleshooting

- **The bridge exits with `getUpdates: 401` (or `getChat: 401`).** The token is wrong or revoked. Check `TELEGRAM_BOT_TOKEN`, or get a new one from @BotFather.
- **The bridge exits with `getUpdates: 409 ...`.** Another program polls the same bot or a webhook is set. Stop the other program, or remove the webhook, then start again.
- **`another telegram bridge is running (pid N)`.** A second copy cannot run on the same data dir. Stop the first one. A lock of a dead process is taken over by itself.
- **`... is not a forum supergroup`.** Enable **Topics** in the group settings.
- **`TELEGRAM_CHAT_ID is the id of a group that was upgraded to a supergroup`.** You took the id before turning Topics on. Run `npm run telegram -- --pair` again, write in the group and set the new `TELEGRAM_CHAT_ID`.
- **`TELEGRAM_ALLOWED_USER is not set` / `TELEGRAM_CHAT_ID is not set`.** Run `npm run telegram -- --pair` and set both ids.
- **`--pair` waits forever.** The bot does not see plain text: make it an admin of the group, or turn privacy mode off with `/setprivacy` in @BotFather and add the bot again (see Setup).
- **Nothing arrives in Telegram.** Check that Jarvis runs and `JARVIS_URL` points at it (the log says `events <workspace>: ...` when it cannot connect). Only the arbiter's text is sent (no agent-finished notices), and only what is newer than the last one sent (a new workspace: its last `TELEGRAM_BACKFILL` messages; `TELEGRAM_BACKFILL=0` sends no history).
- **My message gets no reaction and no answer.** It was not accepted: check that it is text, written in a topic (not General) by `TELEGRAM_ALLOWED_USER` in `TELEGRAM_CHAT_ID`, and not forwarded or sent as an anonymous admin. Make the bot an admin of the group.
- **A topic is missing.** The bridge makes it within 10 s and needs the **Manage Topics** right; the log says `topic for <workspace>: ...` when it fails. A workspace that was archived or deleted loses its topic entry; when it comes back, it gets a new topic.
