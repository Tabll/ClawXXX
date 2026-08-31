# Third-Party Notices

This file records the redistribution review for optional ClawX kernel runtime artifacts. Generated runtime-specific dependency notices and SBOMs are additional release artifacts and do not replace this record.

## OpenClaw

- Project: `openclaw/openclaw`
- Frozen release: `2026.7.1-2`
- Upstream commit: `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`
- License: MIT
- Distribution model: a separately downloadable, immutable runtime artifact produced by ClawX CI.
- Modifications: reviewed ClawX patch series declared in `kernels/openclaw/source.json`; modified artifacts must identify the upstream version and ClawX patch provenance.
- Notice requirement: include the upstream MIT license and the generated notices for every dependency shipped in the runtime artifact.

## DeepSeek Harness

- Project: `deepseek-ai/deepseek-harness`
- Frozen release: `0.1.2-alpha.2`
- Upstream commit: `0a53fb55bea101816fa226bb964ae2bed71c343b`
- License: MIT
- Distribution model: a separately downloadable, immutable runtime artifact produced by ClawX CI.
- Modifications: ClawX persistence/ACP/control bridge packages and any patch series are declared in `kernels/deepseek-harness/source.json` and the artifact provenance.
- Notice requirement: include DeepSeek Harness's `LICENSE`, its upstream `THIRD_PARTY_NOTICES.md`, and generated notices for the exact dependency closure shipped in the artifact.

## Node.js runtime

- Project: Node.js
- Frozen runtime: `24.15.0` (module ABI 137)
- Source: official per-platform archives recorded in `kernels/node-runtime.json`
- License: MIT plus the third-party notices included in the official Node.js distribution.
- Distribution model: every kernel artifact contains its own minimal, SHA-256-verified runtime; it is not shared through the host app or another kernel installation.
- Notice requirement: preserve Node.js `LICENSE` in each artifact and include it in the generated SPDX/CycloneDX and runtime notice provenance.

## Tencent openclaw-weixin media protocol implementation

- Project: `@tencent-weixin/openclaw-weixin`
- License: MIT
- Copyright: Copyright (C) 2026 Tencent. All rights reserved.
- Use: ClawX Channel Relay's buffer-only WeChat AES-128-ECB CDN upload/download flow is adapted from the upstream implementation; no OpenClaw runtime dependency is introduced into the Relay.
- Notice requirement: preserve Tencent's MIT copyright and permission notice in application distributions that include the adapted implementation.

## Reviewed reciprocal-license obligations in the OpenClaw closure

The exact per-platform package closure is audited during runtime CI and written to `metadata/licenses.json`, the SPDX SBOM, the CycloneDX SBOM, and provenance. The following packages require more than preservation of a permissive notice:

| Package | Frozen version/license | Release obligation |
| --- | --- | --- |
| `libsignal` | `6.0.0`, GPL-3.0 | Ship the GPL text and publish/provide the exact corresponding source; obtain release-counsel approval before public promotion. |
| `codec-parser` | `2.5.0`, LGPL-3.0-or-later | Preserve notices, publish exact corresponding source, and preserve replacement/relinking rights. |
| `@img/sharp-libvips-*` | `1.2.4`, LGPL-3.0-or-later | Preserve libvips notices, publish corresponding source/build material, and preserve dynamic replacement/relinking ability. |
| `web-push` | `3.6.7`, MPL-2.0 | Preserve the MPL and make the exact covered source files, including modifications, available. |

CI refuses any reciprocal-license dependency without a version-scoped obligation in `kernels/license-policy.json`. The release owner must attach the corresponding-source locations and legal approval to the production promotion; an automated pass is not legal approval.

## Explicitly excluded package

`@tencent-connect/qqbot-connector` is marked `UNLICENSED` and is not redistributed. Runtime bundling removes the QR connector and its dependency/lock entries. The MIT-licensed OpenClaw QQ plugin remains available through manual AppID/AppSecret configuration.

Packages with missing or ambiguous metadata are accepted only by an exact name/version override with recorded evidence. This currently covers `@larksuite/openclaw-lark@2026.7.9`, `duck@0.1.12`, `exif-parser@0.1.12`, and `qrcode-terminal@0.12.0`; a version change fails closed and requires a new review.

## Review decision

Both upstream projects use the MIT License, which permits use, modification, and redistribution provided the copyright and license notices are preserved. Their dependency closures can impose additional obligations listed above. ClawX CI must fail an artifact build when license metadata is missing, a dependency has an unreviewed license, a source/patch hash differs, or the license report/SBOM/provenance is absent. This engineering review is not a substitute for organization-specific legal review before public distribution.
