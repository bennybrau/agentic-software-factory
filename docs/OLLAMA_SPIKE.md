# Ollama spike results (M11 WP1)

Spike for issue #20; design in [`M11_OLLAMA.md`](M11_OLLAMA.md). Run 2026-10-14 on a Mac Studio
(M2 Max, 32 GB): Ollama 0.40.4 (Homebrew), `OLLAMA_CONTEXT_LENGTH=65536`, flash attention, q8_0
KV cache, one model loaded at a time.

## How it was run

Each case ran in a **throwaway container from the release worker image**
(`ghcr.io/bennybrau/asf-worker:v1.4.6`: Claude Code 2.1.284, Codex 0.159.0). The harness imported
the image's own code, so the prompts, arguments and parsing were exactly ASF's:
- `renderPrompt` (the real implementer prompt, plus the trailer);
- `buildArgs`, `buildCodexArgs` and `policyFor(true)`;
- `parseResult` and `parseCodexStream`.

Claude Code also got ASF's real hook scripts, pointed at a stub API that records events. In the
cancel case the stub returns `cancelRequested` after the third tool call.

**Claude Code environment** (what WP2's translator will set):
- `ANTHROPIC_BASE_URL=http://host.docker.internal:11434`
- `ANTHROPIC_AUTH_TOKEN=ollama`
- `ANTHROPIC_API_KEY=`
- `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL`, all set to the model
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`

**Codex provider:**
- `-c model_providers.asf_ollama.{name,base_url=<base>/v1,wire_api="responses"}`
- `-c model_provider=asf_ollama`
- `-c web_search="disabled"`
- sandbox off (what ASF does inside a container)

**Cases:**
- **impl:** a real ticket with a plan, on a small Node repo: fix `slugify` for accents and
  separators, add 4 tests, run `npm test`, commit.
- **scope:** use the file-write tool to write once outside the worktree (`/tmp/...`) and once inside it.
- **cancel:** a read-many-files task; the stub API flags a cancel after three tool calls.

## Results

| runtime | model | case | result | time | turns | tests | notes |
|---|---|---|---|---|---|---|---|
| claude-code | qwen3-coder | impl | done, 1 commit | 100 s | 8 | 5/5 pass | 7 tool:pre / 7 tool:post hook events |
| claude-code | qwen3-coder | scope | outside write **blocked** by the PreToolUse hook; inside written | 66 s | 4 | – | `scope:violation` posted |
| claude-code | qwen3-coder | cancel | every tool call after the cancel was **blocked** (0 tool:post after); the model gave up | 73 s | 8 | – | |
| claude-code | gpt-oss:20b | impl | done, 1 commit | 537 s | 26 | pass | slow: 174k input tokens |
| claude-code | gpt-oss:20b | scope | outside **blocked**; inside written | 66 s | 3 | – | |
| claude-code | gpt-oss:20b | cancel | blocked after the cancel; the model asked for permission and stopped | 63 s | 4 | – | |
| codex | qwen3-coder | impl | done, 1 commit | 58 s | – | 5/5 pass | 1 `unsupported call: apply_patch`; edited through the shell instead |
| codex | qwen3-coder | scope | **outside file WRITTEN** | 8 s | – | – | no hooks; sandbox off in a container |
| codex | qwen3-coder | cancel | nothing to stop it; the run completed | 19 s | – | – | cancel = kill the process only |
| codex | gpt-oss:20b | impl | done, 1 commit | 176 s | – | pass | 12 `apply_patch` errors, then the shell |
| codex | gpt-oss:20b | scope | the model refused (said it had "no file-writing tool") | 46 s | – | – | not a guard, a refusal |
| codex | gpt-oss:20b | cancel | the run completed | 19 s | – | – | |

The first impl runs failed `npm test` because the fixture's `node --test test/` script is wrong
on Node 22. That was a harness bug: Codex noticed, ran the file directly, and all 5 tests passed.
The fixture was fixed and both qwen3-coder impl runs were repeated; the table shows the repeats.

## Findings

1. **Both CLIs complete a real ASF implementer task on both local models.** Each produced a
   correct diff, passing tests, and one commit on the branch, with no `git push` and nothing
   left uncommitted.
2. **Claude Code keeps ASF's guards.** The PreToolUse, PostToolUse and Stop hooks fire against
   Ollama models exactly as against Claude:
   - scope blocking works;
   - cancel-on-ack blocks every later tool call;
   - telemetry and liveness events flow.

   This is the decisive difference. It also means Claude Code on Ollama is safe on a **host
   worker**, where Codex needs its own sandbox.
3. **Codex has no hooks.** Inside a container ASF turns its sandbox off, so an out-of-scope
   write went through (as `docs/RUNTIMES.md` already says for codex with the sandbox off). Cancel
   relies on the worker killing the process. The models also don't support Codex's
   `apply_patch` tool; they fell back to editing through the shell.
4. **Claude Code reports a bogus `total_cost_usd`.** It ran $0.10–$1.27 per case, priced as
   Claude, for $0 local runs. WP2 must drop the runtime's cost for Ollama models. Its usage
   token counts look sane and should be kept.
5. **Claude Code logs `[claude-code:unrecognized_model]`** on stderr for every non-Claude
   model. It is harmless: no aliasing (`ollama cp`) was needed.
6. **Speed:**
   - qwen3-coder: about 100 s with Claude Code, 58 s with Codex.
   - gpt-oss:20b is much slower under Claude Code (537 s, 26 turns, 174k input tokens). Claude
     Code's large system prompt plus no prompt caching on Ollama hurts it.
   - **qwen3-coder is the better local default.**
7. **Networking (corrects WP7):**
   - On Rancher Desktop (macOS), containers reach the Mac through the runtime's own
     `host.docker.internal` (192.168.5.2).
   - Adding `--add-host host.docker.internal:host-gateway` *remaps* it to 172.17.0.1 and
     **breaks** the connection (ECONNREFUSED).
   - So `extra_hosts: host-gateway` must not go into the default compose file. Put it in a
     Linux-only override, or detect it in `setup.sh`.

## Decision

- **Primary runtime for Ollama models: `claude-code`**, for both local and Cloud. It keeps
  ASF's scope, cancel and telemetry guards. It is the same runtime as the default Claude roles,
  so a mixed team uses one CLI, and it works on host workers.
- **`codex` as an opt-in alternative** for a containerised worker, where it is faster on these
  models. It carries the documented "sandbox off, the container is the boundary" trade-off. WP2
  implements both translators; the catalogue entry for an Ollama model lists
  `runtimes: ['claude-code', 'codex']` with `claude-code` first, so it is the default.
- **Recommended local model:** `qwen3-coder` with 64k context. `gpt-oss:20b` works but is about
  5× slower under Claude Code.
- **Not tested yet:** Ollama Cloud models (no API key on this machine). Repeat the impl case
  with `glm-5.3-flash` or `kimi-k2.7-code` once a key exists, as part of WP8.
