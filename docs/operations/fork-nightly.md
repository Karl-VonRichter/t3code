# Karl's fork nightly

`Karl-VonRichter/t3code` publishes Mac arm64, Windows x64 and Linux x64 builds
from its `main` branch through **Fork nightly**. It runs on a main push, manual
dispatch or daily at 03:17 UTC. A scheduled run skips an already published
commit. Upstream changes must first be merged into fork main; this workflow
does not automatically merge or resolve conflicts.

The build includes the Codex/Claude maintenance-path change from upstream PR
[#23890](https://github.com/pingdotgg/t3code/pull/23890). Its release pipeline
reuses upstream packaging, native CLI smoke checks and desktop launch checks.
Publication waits for all three platform jobs, including Windows verification.
Installers and CLI archives carry checksums. Releases are prereleases and never
replace the repository's stable/latest release.

## Switch a desktop once

Download the installer for your architecture from the fork's GitHub Releases.
Quit T3 before replacing the installed app. A fork build is required once:
an upstream installation follows the upstream feed, not this fork's releases.
Windows and Linux fork builds embed this repository's nightly feed. Existing
provider paths, AgentFleet routing and provider credentials remain configured
in T3 settings; they are not embedded in the release.

Codex and Claude CLI installations remain separate. AgentFleet continues its
idle-aware, compatibility-gated provider updates. Remote T3 servers use the
matching platform CLI archive from the same release.

## Mac signing

Without Apple signing credentials, the Mac download is an unsigned manual
install with no in-app update feed. macOS passkeys require a signed, provisioned
app. The workflow does not disable signature verification to enable updates.

To enable signed Mac nightlies, configure the fork's `CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`
secrets, plus its `APPLE_TEAM_ID` variable, using
the existing [release signing procedure](release.md). Configure secrets through
GitHub's private settings, never in source or chat. Publish a new nightly and
install that signed app once before following subsequent signed updates.

The fork sets `mac_passkeys: false` in the reusable desktop workflow. That sets
`T3CODE_DESKTOP_MAC_PASSKEYS=false` in the packager: signing and notarization
remain enabled, and restricted passkey entitlements are omitted. Passkeys need a
matching `MACOS_PROVISIONING_PROFILE` and the Clerk/AASA registration described
in the release procedure. The reusable workflow keeps passkeys enabled by
default and still requires that profile for other callers.

Upstream-only **CI** and **Release** workflows are disabled on this fork;
**Fork nightly** supplies its own hosted-runner checks and publishing path.
