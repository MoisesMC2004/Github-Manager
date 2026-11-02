# GitHub Manager CLI

Interactive CLI for managing multi-account GitHub configurations, isolated SSH identities, and repository synchronization.

It binds dedicated Ed25519 SSH keys and author credentials directly to each repository (`core.sshCommand` and `user.name`), avoiding identity collisions without modifying `~/.ssh/config` or global Git settings.

## Quickstart

```bash
# Install
pnpm install

# Run
pnpm start
```

*Requires Node.js 18+, Git, pnpm (or npm), and OpenSSH.*

## Menu Options

* **Publish Project**: Inits local repo, creates remote on GitHub via API, sets profile identity, and pushes.
* **Quick Sync (Sync & Branches)**: Inspects status, commits, checks for conflicts, and pushes the active branch. Supports branch switching, creation, and auto-stashing.
* **Sync All**: Batch commit and push across all tracked repositories, skipping up-to-date repos.
* **Delete Repository**: Permanently deletes a remote repository on GitHub via API with double confirmation.
* **Profiles & Preferences**: Manages accounts, generates dedicated Ed25519 SSH keys, tests connectivity, and stores API tokens.

## Identity Isolation

GitHub Manager preserves standard Git URLs (`git@github.com:owner/repo.git`) and isolates accounts per repository:
1. Generates dedicated keypairs: `~/.ssh/id_ed25519_<username>`.
2. Sets repository-local SSH command:
   ```bash
   git config --local core.sshCommand "ssh -i ~/.ssh/id_ed25519_<username> -o IdentitiesOnly=yes"
   ```
3. Executes pushes with `GIT_SSH_COMMAND` bound to the profile key, preventing fallback to default SSH credentials.

## Security

* **Parameterized Calls**: All Git commands execute as argument arrays (`spawnSync`), eliminating command injection.
* **Strict Permissions**: Config files (`~/.git_profiles.json`, `~/.github_tokens.json`) are written with `0600` permissions; `~/.ssh` is enforced with `0700`.
* **Token Scopes**: Requires only `repo` (and `delete_repo` if using remote deletion).

## License

MIT
