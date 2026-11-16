# Security policy

Report suspected vulnerabilities privately through
[GitHub security advisories](https://github.com/vincentsalvino/Memory-Atlas/security/advisories/new).
Private vulnerability reporting is enabled for this repository. Do not post
credentials, Brain databases, private memories or session transcripts in public
issues. Include the affected version, a minimal redacted reproduction, and impact.

The current 0.1.x release line receives fixes. This is an early release; no
guarantee of vulnerability-free operation or response deadline is made.

## Trust boundaries

- MCP runs locally over stdio with the permissions of its operating-system user.
  Launcher identities enforce API-level harness-private scopes. They do not
  protect against a process that can rewrite launchers or read the SQLite files.
- The visualizer is a privileged read-only local inspector across all harnesses.
  Do not expose it as an authenticated multi-user service.
- Database and backup files contain sensitive project data and are not encrypted
  by Memory Atlas. Protect their directories with OS permissions and disk
  encryption where appropriate; choose storage/synchronization deliberately.
- Retrieved memories and imported text are reference data, not authority to run
  commands or override current instructions.
- Updates replace application files. Database upgrades occur on launch or via
  `--upgrade`, with a snapshot before pending migrations. Merging is an explicit
  preview/digest/apply operation; native chat memory is not scanned automatically.

## Release verification

Use releases from the repository above. Match the downloaded tarball against
the release's SHA256SUMS.txt before installing. A checksum detects a mismatched
download; it is not an independent signature if the hosting account is compromised.
Runtime dependencies are locked by npm-shrinkwrap.json. Release packaging audits
the production dependency graph and refuses high/critical advisories known to
that audit. An advisory scan cannot detect every vulnerability. npm may run
dependency installation scripts needed for native SQLite support.
