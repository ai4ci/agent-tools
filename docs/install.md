# Installing the remote explorer

The same six tools are available in pi and in Claude Code. They differ only in how
each host loads them: pi registers custom tools natively, while Claude Code has no
tool-registration mechanism other than MCP (ADR-003).

## 1. Configure hosts first

Neither host can reach anything until a host is declared. The agent supplies an
alias and never an SSH target, so this file is the entire boundary of where the
tools can reach (ADR-004).

Create either of:

- `~/.config/agent-tools/config.json` — applies everywhere
- `<project>/.agent-tools/config.json` — applies to one project, and overrides the
  user-level file per alias

```json
{
  "version": 1,
  "hosts": {
    "prod-web": {
      "ssh": { "target": "deploy@web1.example.com" },
      "root": "/srv/app"
    },
    "build-box": {
      "ssh": {
        "target": "ci@build.example.com",
        "port": 2222,
        "identityFile": "~/.ssh/id_ed25519_ci"
      },
      "root": "$PROJECTDIR",
      "limits": { "timeoutMs": 60000, "maxOutputBytes": 2000000 }
    }
  }
}
```

`root` is either an absolute path or a bare shell variable such as `$PROJECTDIR`,
which is expanded on the remote host because only the remote login shell can
resolve it. Anything more complex is rejected: `$(whoami)` and `${HOME:-/etc}` are
refused at load time, deliberately (ADR-007).

### Requirements on each remote host

- **passwordless SSH** — key-based auth. `BatchMode=yes` is always set, so a
  missing key fails immediately rather than prompting.
- **`bubblewrap` (`bwrap`), with unprivileged user namespaces permitted.** Every
  command runs inside a sandbox, and a host that cannot create one is **refused
  outright** — there is no unsandboxed mode (ADR-006). If a host is rejected,
  check:

  ```sh
  bwrap --ro-bind / / --unshare-net true    # must exit 0
  ```

  On Ubuntu 24.04 and similar, this is denied by default and needs
  `kernel.apparmor_restrict_unprivileged_userns=0`.
- `grep` and `find`. `ripgrep` is used instead of `grep` when present.

## 2. Build

```sh
npm install
npm run build
```

## 3a. pi

Install from a local checkout:

```sh
pi install /path/to/agent-tools/adapters/pi
```

Or try it for a single run without installing:

```sh
pi -e /path/to/agent-tools/adapters/pi/dist/index.js
```

The tools appear as `remote_hosts`, `remote_ls`, `remote_stat`, `remote_find`,
`remote_grep`, `remote_read`.

## 3b. Claude Code

Register the MCP server. Project-scoped, via `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "remote-explorer": {
      "command": "node",
      "args": ["/path/to/agent-tools/adapters/mcp/dist/index.js"]
    }
  }
}
```

Claude Code namespaces MCP tools, so they appear as
`mcp__remote-explorer__remote_ls` and so on. The server itself uses the bare
names; the prefix is added by the host.

## What the tools can and cannot do

Read-only exploration, confined to each host's configured root:

- the root is bind-mounted read-only, so writes fail
- the sandbox has no network access
- nothing outside the root and the toolchain is visible
- paths are resolved on the remote host, so a symlink pointing out of the root is
  refused rather than followed

**One current limitation worth knowing.** There is no content filtering *within*
the root. If a `.env` or a private key sits below the configured root, the tools
can read it and the contents will enter the transcript. `.aiignore` support is
planned (ADR-010) but not yet implemented, so choose each `root` as though
everything under it is readable — because it is.
