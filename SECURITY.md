# Security Policy

## Scope

agent-skill is an admission and runtime-control layer for Agent Skills. Its
sandbox is process-level, not kernel-level, and is not a security boundary.
The documented coverage and limits are in [docs/PROPOSAL.md](docs/PROPOSAL.md).

In scope:

- Bypasses of the install-time admission gates (G1–G4) by a skill that is
  nevertheless accepted.
- Runtime permission or trust-tier enforcement bypasses in `agent-skill run`.
- Credential exposure through trace events or evidence artifacts.
- Path traversal in admission or sandbox file handling.

Out of scope:

- A malicious skill that the operator explicitly admits with `--gate`
  disabled or with a forged trust tier.
- Hosts that execute `!`command`` preprocessing before any admission step.
  Hooks-only adapters cannot cover that moment; only `verify` and the
  standalone runtime can.
- Denial of service from intentionally unbounded workloads beyond the
  documented sandbox limits.

## Reporting

Report privately through the repository's GitHub Security Advisories. If that
channel is unavailable, open an issue asking for a private channel without
disclosing details. Include the skill fixture, the command used, and the
observed trace. Do not include live credentials.

We aim to acknowledge within 3 business days and to publish a fix or a
documented mitigation within 30 days.

## Supported versions

Only the latest minor release receives security fixes.
