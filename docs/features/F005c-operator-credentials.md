---
feature_ids: [codeteam/F005c]
related_features: [codeteam/F005]
title: "F005c: operator / service 凭据与权限门"
status: in-progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: []
created: 2026-10-28
updated: 2026-10-28
---

# F005c: operator / service 凭据与权限门

> F005（W2）的凭据切片。验收以 `docs/plans/0002` §W2 为准；本文件只记本批交付。

## Why

F005a 解决了 agent 侧 per-run 身份，但 operator 侧还是空白：approval decide 与
routine merge 没有可验证的 principal，任何持有 run token 的进程都能冒充。W2 要求
operator credential（本地 key，rotation 即撤销）与 `service:merge-owner` 的
per-merge short-TTL credential。

## What

- **operator credential**（`initOperatorCredential` / `codeteam auth init`）：
  Ed25519 keypair，`<dataDir>/credentials/operator.key` + `.pub`，目录 0700 /
  文件 0600 / 原子写；`--rotate` 换钥即撤销旧签名；fingerprint = pub DER 的
  sha256 前 16 hex。
- **签名工具**：`signOperatorPayload` / `verifyOperatorSignature`（CLI 直接签名，
  daemon 用公钥验）。
- **权限门**（`principals.ts`）：`assertApprovalDecisionPrincipal` 只接受
  operator；`assertMergeExecutionPrincipal` 只接受 `service:merge-owner`。
- **per-merge service credential**（`issueMergeServiceCredential` /
  `verifyMergeServiceCredential`）：Ed25519 签名 + `(repo, prRef, headSha)` 绑定
  + 短 TTL（≤15min）；过期/换绑/篡改一律 forbidden。
- **CLI**：`codeteam auth init [--data-dir <path>] [--rotate]`。

## Acceptance

- [x] operator key 0600 / 目录 0700 / 原子写；重复 init 幂等，`--rotate` 换 fingerprint。
- [x] rotation 后旧签名验证失败（撤销语义）。
- [x] approval decide：operator 放行；run token / agent-key 403。
- [x] merge 执行：仅 `service:merge-owner`；run/operator principal 均 403。
- [x] merge credential：绑定 repo/prRef/headSha、TTL ≤15min、过期/换绑/篡改拒绝。
- [x] `codeteam auth init` CLI 可用（含 `--rotate`）。
- [x] 包内 122/122、包 build、Biome 通过。
- [ ] 非作者安全 review（砚砚）与 merge。

## Out of scope

- `auth console-link`（loopback-only 短时效 session token）随 W7a。
- merge executor adapter（local git / W8 GitHub）与 E1–E5 前置核验的运行时接线。
- approval decide 的实际 HTTP/MCP 入口（W7a 鉴权矩阵）。

[宪宪/deepseek-flash🐾]
