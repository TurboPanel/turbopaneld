# Third-party notices

This file is generated from the resolved dependency graph. Do not edit it by hand. Regenerate with `deno task notices:generate`.

Third-party components remain under their own copyright and license terms and are not relicensed by TurboPanel Daemon's repository license (AGPL-3.0-only).

<!-- lockfiles
deno.lock sha256:b4e413d18b6b68272808cee6d903a05eaf4bbfbb61941e80b211a1a8f81020a8
orchestration/requirements.lock.txt sha256:2a2b88cc97affa78a54c1635b65333eb1259a4aa49f251cfc41aaa0261f2e673
orchestration/requirements.txt sha256:bcd5495ade36b7203ef5411fe77be58d740df3437810a00332203a1bbc162162
orchestration/requirements.yml sha256:23a8d5078fc5e56246e822a0e30e88a10d58c0f252d708b034651274bee039f0
-->

## Production dependencies

### @std/internal@1.0.14

- License: MIT
- Source: deno.lock (jsr)

### postgres@3.4.5

- License: Unlicense
- Source: deno.lock (npm)

### yaml@2.9.0

- License: ISC
- Source: deno.lock (npm)

## Development-only dependencies

These packages are used for development, test, or build tooling and are not bundled into shipped artifacts.

### @std/assert@1.0.19

- License: MIT
- Source: deno.lock (jsr)

### @std/crypto@1.1.0

- License: MIT
- Source: deno.lock (jsr)

### @std/encoding@1.0.10

- License: MIT
- Source: deno.lock (jsr)

### @std/path@1.1.5

- License: MIT
- Source: deno.lock (jsr)

### @std/testing@1.0.19

- License: MIT
- Source: deno.lock (jsr)

## Orchestration tooling

Python / Ansible Galaxy pins installed into the host orchestration environment. GPL-3.0-or-later here is an intentional, reviewed exception — not a general production-JS allow.

### ansible-compat@>=25,<26

- License: GPL-3.0-or-later
- Source: orchestration

### ansible-core@==2.20.*

- License: GPL-3.0-or-later
- Source: orchestration

### ansible-lint@>=25,<26

- License: GPL-3.0-or-later
- Source: orchestration

### ansible.posix@2.2.1

- License: GPL-3.0-or-later
- Source: orchestration

## Native dependencies

_None._
