# Free models with Ollama

Run any job in the AI team (plan, write the code, test, review) on an **Ollama** model,
next to Claude in the same team. Two kinds:

- **Ollama on your computer**: a model on this machine, or on another one on your network.
  It costs nothing and the code never leaves the network, but it is only as fast as the
  machine's GPU.
- **Ollama Cloud**: large open models hosted at `ollama.com`, with an API key. Your Ollama
  plan pays for them (the free plan has hourly and weekly limits).

ASF counts both as **free**. The run view shows "free (Ollama)", and no Ollama job counts
toward your spending limits. Because a spending limit never stops a free job, a separate
**time limit** does that (see [Limits](#limits)).

Ollama models run under the `claude-code` runtime, which keeps ASF's scope, cancel and
activity guards. [`OLLAMA_SPIKE.md`](OLLAMA_SPIKE.md) has the evidence. Anthropic does not
support Claude Code against non-Claude models, so a Claude Code update can break it. The
worker's startup check and **Check** in Settings catch that.

## 1. Set up the Ollama server (Ollama on your computer)

Skip this section if you only want Ollama Cloud.

ASF needs three things from the server:

| what | why |
| --- | --- |
| **Ollama 0.14.0 or later** | Its Anthropic-compatible API is what Claude Code talks to. |
| **A context of at least 64k**: `OLLAMA_CONTEXT_LENGTH=65536` | Ollama's default can be as small as 4k. With a small context the agent quietly forgets the task halfway through. |
| **Listening on every interface**: `OLLAMA_HOST=0.0.0.0` | So containers and other machines can reach it. Needed on Linux and for a server on another machine. Docker Desktop and Rancher Desktop on a Mac reach `127.0.0.1` without it. |

### macOS

Install it from <https://ollama.com/download>, or with `brew install ollama`. Then pick the
way you run it:

- **The Ollama app**: in *Settings*, set **Context length** to **64k**. Allow network access
  only if the server is for other machines. Quit and reopen the app.
- **Homebrew service** (`brew services start ollama`): give the service the variables, then
  restart it:

  ```bash
  launchctl setenv OLLAMA_CONTEXT_LENGTH 65536
  launchctl setenv OLLAMA_HOST 0.0.0.0:11434     # only if other machines use it
  brew services restart ollama
  ```

  `launchctl setenv` lasts until you restart the Mac. To keep it, add the same lines under
  `EnvironmentVariables` in `~/Library/LaunchAgents/homebrew.mxcl.ollama.plist`.

### Linux

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl edit ollama
```

In the editor, add:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_CONTEXT_LENGTH=65536"
```

Then:

```bash
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

`install-e2e.yml` runs exactly these steps on a fresh Ubuntu machine in CI.

Docker on Linux does not define `host.docker.internal`, the name ASF's containers use to reach
this machine. `asf` and `setup.sh` handle that: on Linux they add
`docker-compose.host-gateway.yml`, which maps the name for the api and worker containers.
`ASF_HOST_GATEWAY` in `.env` overrides the choice: `1` = always, `0` = never, blank = Linux
only.

> Don't turn it on for Rancher Desktop on a Mac. There the mapping points at the VM, not at
> the Mac, and the connection is refused.

### Get a model

```bash
ollama pull qwen3-coder
```

## 2. Get an Ollama Cloud key (Ollama Cloud)

Sign in at <https://ollama.com>, open **Settings → Keys**, and create a key. ASF sends it
only to `https://ollama.com`, never to a server on your computer or network.

## 3. Turn it on in ASF

Open **Settings → Use free models with Ollama?**, then:

1. **Ollama server address**:
   - **Container worker** (mode 1, the default): `http://host.docker.internal:11434` for this
     machine, or `http://<lan-ip>:11434` for another one.
   - **Host worker** (mode 2): `http://localhost:11434`.

   Leave it blank if you only use Cloud.
2. **Ollama Cloud key**: paste it, or leave it blank.
3. **Find models on this server** / **Find my Cloud models**: lists the models. Tick the ones
   you want. Each ticked model is checked straight away: ASF sends it a short message and
   reads the context the server really loaded it with. A model that fails says why and how to
   fix it, for example a 4k context or an Ollama that is too old.
4. **Save**.

Then pick a model for each job in **Settings → Which AI model does each job?**. The picker
groups models under *Claude*, *OpenAI*, *Ollama on your computer* and *Ollama Cloud*. A team
can mix them, for example Claude plans and reviews while a local model writes the code and
the tests.

### Check it from the command line

```bash
./scripts/asf doctor
```

The **Ollama** section checks:

- whether the server answers **from the worker**, and its version;
- whether the api container reaches it too (Settings' model list and check use the api);
- the context of whichever model is loaded.

A green section looks like this:

```
Ollama
  ✓ Ollama Cloud key saved (sent only to https://ollama.com)
  ✓ server http://host.docker.internal:11434 reachable from the worker: Ollama 0.40.4
  ✓ context: loaded model runs with 65536 tokens
```

| doctor says | fix |
| --- | --- |
| `answers on this host but not from the worker container` | Linux: make sure the overlay is on (`ASF_HOST_GATEWAY` not `0`), then `asf up`. Elsewhere: `OLLAMA_HOST=0.0.0.0`, then restart Ollama. |
| `OLLAMA_BASE_URL is http://localhost:11434: inside a container…` | Use `http://host.docker.internal:11434`. Inside a container, `localhost` is the container itself. |
| `not reachable from the worker` | Ollama isn't running. Jobs on local models wait until it is. |
| `context: a loaded model runs with only 4096 tokens` | Set `OLLAMA_CONTEXT_LENGTH=65536` on the server and restart it. A model whose own maximum is under 64k can't be used (`qwen3:0.6b` stops at 40k, for example). |
| `Ollama 0.12.3 … is too old` | Update Ollama. |

## Which models

The evidence comes from the spike and live runs on real tickets in
[`OLLAMA_SPIKE.md`](OLLAMA_SPIKE.md):

- **Recommended team:** Claude plans and reviews; Ollama Cloud `gpt-oss:120b` writes the code
  and the tests. On real tickets each Cloud role took about a minute, at $0. Planning and
  reviewing are where a weaker model's slips cost the most. In one run, a Cloud planner
  answered with its plan but never saved it as the plan file.
- **All on Ollama Cloud:** fine for small, well-scoped tickets. Check that a plan is actually
  there before you approve it.
- **Ollama Cloud models:** `gpt-oss:120b` and `nemotron-3-super` are on the free plan. Larger
  coding models such as `kimi-k2.7-code` and `glm-5.3` need Ollama Pro.
- **On your computer:** `qwen3-coder` (30B, about 18 GB) is the best local choice;
  `gpt-oss:20b` is about 5× slower under Claude Code. Small models (under about 14B) often lose
  track of the agent's steps. Speed depends on the GPU. On a 32 GB M2 Max (16–18 tokens a
  second), `qwen3-coder` did a small fixture task in about 100 s, but a real ticket in a large
  repository was still going after 22 minutes. Use local models on a fast GPU, or only for
  very small tickets, and set the [time limit](#limits).

## Limits

- **Time limit:** set it in **Settings → Use free models with Ollama? → Time limit**
  (`RUN_MAX_MINUTES`). It is off by default; 180 minutes is a good value. It stops a ticket
  once its AI has worked that long in total. Time waiting for you at an approval or a question
  doesn't count. The run is cancelled with the reason "time limit reached", and you get a
  notification.
- **Per-job limits:** `MAX_TURNS_*` and `SEGMENT_TIMEOUT_MS` bound each job as usual
  ([`CONFIGURATION.md`](CONFIGURATION.md)).
- **Ollama Cloud usage:** ASF doesn't track Cloud usage in dollars. Your plan's hourly and
  weekly limits are on your Ollama account (<https://ollama.com/settings>), linked from the
  Ollama question. When the plan runs out, jobs fail with Ollama's error, not an ASF budget
  stop.

## Settings

| setting | what |
| --- | --- |
| `OLLAMA_BASE_URL` | The server's address, without `/v1`. Blank = no server on your computer or network. |
| `OLLAMA_API_KEY` | The Ollama Cloud key. Write-only. |
| `RUN_MAX_MINUTES` | The time limit (0 = off). |
| `AGENT_PROVIDERS` | Limits what a worker offers, e.g. `ollama` for a GPU machine that runs only Ollama jobs. Blank = everything its checks pass. |
| `ASF_HOST_GATEWAY` | Read by `asf` and `setup.sh` from `.env`, not a service setting: `1`/`0`/blank, whether to map `host.docker.internal` (see [Linux](#linux)). |

Full reference: [`CONFIGURATION.md`](CONFIGURATION.md). Design and work packages:
[`M11_OLLAMA.md`](M11_OLLAMA.md).
