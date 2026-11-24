---
name: herd-cli
description: "Use herd safely for AWS access, cloud status, privilege elevation, ECS scaling, tunnels, prod database queries and exports, and other herd-cli workflows. Defaults to developer/read-only access, requires explicit temporary PowerUser escalation and confirmation for consequential operations, and protects credentials."
---

# Safe herd-cli Usage

Use `herd` instead of recreating its authentication, profile management, or infrastructure workflows
with raw AWS, Spinnaker, or Vault commands.

This skill does not install the `herd` binary. If `herd` is not on PATH, stop and direct the user to
the installation instructions. Do not download or execute the installer on the user's behalf. Resume
only after the user confirms that `herd` is installed.

## Safety Contract

- Start with read-only operations and the developer AWS profile.
- Treat `herd-<account-slug>` as the developer profile. It uses developer access and is the default
  for that account.
- Treat `herd-<account-slug>-power` as the visibly privileged PowerUser profile. Never substitute it
  for the developer profile implicitly.
- Elevate only when the user's requested operation requires write access.
- Before elevation, explain the intended write operation, account, and why developer access is
  insufficient. Obtain the user's confirmation.
- Before any consequential operation, verify the account and role and obtain confirmation for the
  exact change. This includes scaling services, changing infrastructure, and destructive actions.
- Never print, log, store, or relay access keys, secret access keys, session tokens, client secrets,
  or other credentials.
- Never run `herd aws elevate --creds`; agent command execution captures its credential output. If
  the user explicitly requests temporary shell credentials, direct them to run it personally in a
  terminal outside agent capture, and do not ask them to paste or relay its output.
- Stop when the user cancels or a picker reports an abort.
- Respect command availability and `HERD_EXPERIMENTAL=1`. Do not enable an experimental command
  without clear user intent.

## Workflow

1. Inspect available commands with `herd help` or a command's `-h` output.
2. Classify the request as read-only, local configuration, or consequential.
3. For normal AWS access, run `herd aws login` and select the intended account.
4. Use the unsuffixed developer profile for inspection and other read-only work. Verify it before
   relying on the result:
   ```bash
   aws --profile herd-<account-slug> sts get-caller-identity
   ```
5. If write access is required, state the exact planned change and request confirmation before
   running:
   ```bash
   herd aws elevate --account <account-id-or-name>
   ```
6. Use the explicitly named PowerUser profile only for the confirmed write:
   ```bash
   aws --profile herd-<account-slug>-power sts get-caller-identity
   AWS_PROFILE=herd-<account-slug>-power <confirmed-command>
   ```
7. Return to the developer profile after the operation. Do not leave the PowerUser profile exported
   as the shell default.

## Consequential herd Commands

Some `herd` commands perform writes themselves. Describe their effect and ask for confirmation
before invoking them with non-interactive flags. For example, confirm the application, server group,
account, and capacity before running:

```bash
herd aws ecs scale --app <app> --server-group <group> --count <count>
```

Interactive confirmation inside a command does not replace the need to make the agent's intended
operation clear before starting it.

## Read-only Defaults

Prefer commands such as these while gathering context:

```bash
herd help
aws --profile herd-<account-slug> sts get-caller-identity
```

Do not assume every status-looking command is read-only; check `herd help` and the command's help
before execution.

## Failure Handling

- Do not work around a missing `herd` command with lower-level write calls.
- If developer access is denied, do not infer that elevation is authorized.
- If account or role identity differs from the confirmed target, stop.
- If elevation fails or expires, report that state without exposing command output containing
  credentials and request a fresh explicit decision.

## Prod database jobs (queries, exports, imports)

Five labeled sessions lost turns here: tunnels that dropped during long exports, a wrong `.env`,
a pasted password, a herd/jumphost outage. Run this preflight before the first query and report
each line:

1. AWS identity: `aws --profile herd-<account-slug> sts get-caller-identity`.
2. Tunnel or jumphost reachable: `herd aws tunnel --account <account> --host <db-host> --port <port> -- <script>`
   wraps a short job and closes the tunnel with it; for an open tunnel check `nc -z localhost <port>`.
3. DB login: one `select 1` with `default_transaction_read_only = on` (`PGOPTIONS='-c default_transaction_read_only=on'`).
   Read credentials from the source the repo documents. Never ask the user to paste a password, and
   name which `.env` you read.

Then pick where the job runs:

- Short reads (a few minutes, small output): over the tunnel, inside a script passed to `herd aws tunnel ... --`.
- Long exports or imports (more than ~5 minutes or ~1 GB): run them on the jumphost in docker
  (`ssh` in, `docker run postgres:<version> psql|pg_dump ...`, write compressed output there, `scp` it
  back). An SSH tunnel drops under long `COPY` streams; on 2026-08-10 the export stalled over the
  tunnel for 12 turns and finished fast once moved to the jumphost.

If a preflight step or the tunnel fails twice, stop and tell the user what failed (herd itself can be
down, e.g. during a Spinnaker outage) instead of trying variants.
