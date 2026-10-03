# Run your fork with Portainer and Tailscale

This stack builds the server and web app from your fork. It includes Codex and
Claude Code, runs agents as a non-root user, and gives T3 its own private Tailscale
HTTPS address. It uses Docker Standalone, not Swarm, and requires Docker Compose
2.23.1 or newer. Your existing Portainer and Tailscale containers stay separate.

## Deploy

Push `Dockerfile`, `.dockerignore`, and `compose.portainer.yaml` to the branch of
your fork you want to run.

In the Tailscale admin console, enable MagicDNS and HTTPS certificates, then
create a non-ephemeral auth key for the new server. If your tailnet requires
device approval, approve the new device after deployment. Its access rules must
allow your phone and computers to reach the new device on TCP port 443.

In Portainer, choose **Stacks → Add stack → Git repository**:

- Repository: `https://github.com/Karl-VonRichter/t3code`
- Reference: the branch containing the container files
- Compose path: `compose.portainer.yaml`
- Environment variable `TS_AUTHKEY`: your new Tailscale auth key
- Optional `TS_HOSTNAME`: defaults to `t3code`

Deploy the stack. The first build downloads dependencies and compiles the web
app, server, and resource monitor; allow several minutes and enough memory for
the build (8 GB is a useful starting point). The `tailscale` container logs show
its actual tailnet hostname. With the default name on your tailnet, the address
should be `https://t3code.taileef599.ts.net`. Use the actual hostname if Tailscale
adds a suffix because that name is already taken.

No host ports are published. HTTPS is provided by Tailscale Serve within the
tailnet. The stack does not enable public Tailscale Funnel access.

## Pair your devices

Open a `/bin/sh` console in Portainer for the stack's `t3` container, as user
`node`, and run:

```sh
t3 auth pairing create --ttl 30m --base-url https://t3code.taileef599.ts.net
```

Use your actual hostname if it differs. Open the printed **Pair URL** in a
browser, or paste it into **Add environment** in the T3 mobile or desktop app.
Your device must be connected to the same tailnet. The link is valid for 30
minutes; generate a fresh link for each device.

These links allow coding, terminals, and provider configuration. To administer
client access in Connections settings, use the startup pairing link from the
`t3` container logs instead. Replace the HTTP origin printed in that link with
the server's Tailscale HTTPS origin, keeping the path and token intact.

## Sign in and add projects

For Codex, use **Settings → Providers** on this environment to connect with
ChatGPT. Alternatively, run this in the container console:

```sh
codex login --device-auth
```

For Claude Code, run:

```sh
claude auth login
```

Follow the sign-in instructions on your own device. If the login flow cannot
open a browser in the container, open its printed URL yourself and follow any
code-paste instructions.

Clone projects into `/workspace` using the container console or T3 terminal, then
add their directories in T3. `gh auth login` is available for GitHub access. The
image includes Node.js, npm, Git, GitHub CLI, Python, make, a C++ compiler, and
ripgrep. Add other project-specific tools to the Dockerfile and rebuild when
needed.

The `agent-home` volume preserves T3 history, settings, provider credentials,
GitHub login, and SSH configuration. The `projects` volume preserves repositories.
The `tailscale-state` volume preserves the server's tailnet identity. Back up
these volumes; deleting them resets that state. Avoid deleting volumes when
removing or replacing the stack, and reuse the same stack name when redeploying.

## Update

Push changes to the selected fork branch, then update the stack from Git in
Portainer. The image rebuilds from that source; pause active agent work before
restarting it. Update the pinned Codex and Claude versions in the Dockerfile to
update those CLIs. T3's built-in release updater is for published releases, so
use a stack rebuild to update this source-built fork.

Tailscale state persists across rebuilds and `TS_AUTH_ONCE` avoids repeated
authentication. You can revoke the enrollment key after the first successful
deployment. If you delete the Tailscale state volume or need to authenticate the
device again, supply a fresh auth key in Portainer.

Background mobile push notifications still require T3 Connect. This build does
not supply T3 Connect's Clerk/relay configuration; use direct Tailscale pairing.
