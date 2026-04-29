# LLM Vertex AI 路由与 PayGo

本文档是 `features/llm` 中 Vertex AI 调用语义的唯一说明入口。Google 官方 Priority/Flex PayGo 文档要求使用 `global` 端点，并通过 Vertex header 指定 PayGo 类型；本模块用不同的 model key 前缀把 Express Mode 和 project/global 模式明确拆开。

官方参考：

- Priority PayGo: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/priority-paygo
- Flex PayGo: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/flex-paygo

## 两种 Vertex Provider

| Model key 前缀 | 语义 | URL 形态 | 主要用途 |
|---|---|---|---|
| `vertex:*` | Vertex AI Express Mode | `/v1/publishers/google/models/...` | API key 直连，兼容既有调用 |
| `vertex-global:*` | Vertex AI project/global mode | `/v1/projects/{project}/locations/global/publishers/google/models/...` | 官方 Priority/Flex PayGo 路径 |

不要用 `vertex:*` 表达 Priority PayGo 的官方验证路径。`vertex:*` 可以发送 tier header，但 URL 仍是 Express Mode；需要和 Google 文档完全一致时，使用 `vertex-global:*`。

## `vertex-global` 配置

必需配置：

```bash
GOOGLE_VERTEX_PROJECT=unee-472712
GOOGLE_VERTEX_LOCATION=global
```

兼容 Google SDK 变量名：

```bash
GOOGLE_CLOUD_PROJECT=unee-472712
GOOGLE_CLOUD_LOCATION=global
```

认证方式：

- 优先使用 `AI_GOOGLE_VERTEX_API_KEY`。
- `GOOGLE_VERTEX_API_KEY` 仍作为兼容 fallback 可用，虽然新项目应迁移到 `AI_GOOGLE_VERTEX_API_KEY`。
- 如果没有 API key，AI SDK 会走 ADC / service account / Workload Identity 的 OAuth 路径。

`vertex-global` 会强制 location 为 `global`。如果配置成 `us-central1` 等区域，会在初始化时报错，因为 Google 文档说明 Priority/Flex PayGo 不支持区域级或多区域级端点。

## Model Spec 参数

标准 PayGo，不发送 tier header：

```typescript
model: 'vertex-global:gemini-2.5-flash'
```

先用 Provisioned Throughput，如有剩余；不足时溢出到 Priority PayGo：

```typescript
model: 'vertex-global:gemini-2.5-flash?tier=priority'
```

只使用 Priority PayGo，不走 PT：

```typescript
model: 'vertex-global:gemini-2.5-flash?tier=priority&vertexRequestType=shared'
```

Flex PayGo 同理：

```typescript
model: 'vertex-global:gemini-3-flash-preview?tier=flex&vertexRequestType=shared'
```

参数映射：

| Spec 参数 | Header | 值 |
|---|---|---|
| `tier=priority` | `X-Vertex-AI-LLM-Shared-Request-Type` | `priority` |
| `tier=flex` | `X-Vertex-AI-LLM-Shared-Request-Type` | `flex` |
| `vertexRequestType=shared` | `X-Vertex-AI-LLM-Request-Type` | `shared` |

`vertexRequestType=shared` 只有在 `tier=priority` 或 `tier=flex` 时生效；单独配置会被忽略并输出 warning。

## 生效验证

Google 文档要求以响应中的 `trafficType` 验证是否实际命中 PayGo tier。本模块会把 AI SDK 返回的 raw usage 原样保留在 `usage.raw`，Vertex 返回值通常在：

```typescript
result.usage.raw.trafficType
```

判定方式：

| `trafficType` | 含义 |
|---|---|
| `ON_DEMAND_PRIORITY` | 实际使用 Priority PayGo |
| `ON_DEMAND_FLEX` | 实际使用 Flex PayGo |
| `ON_DEMAND` | 标准 PayGo，或请求被 Google 降级 |

注意：发送了 header 不等于每次都保证返回 `ON_DEMAND_PRIORITY`。Google 文档说明，如果超过升速限制或系统容量紧张，Priority PayGo 请求可能降级为标准 PayGo，此时 `trafficType` 会是 `ON_DEMAND`。

最小真实调用示例：

```typescript
import { LLM } from '@app/features/llm';

const result = await LLM.generateText({
  id: 'vertex-priority-ping',
  model: 'vertex-global:gemini-2.5-flash?tier=priority&vertexRequestType=shared',
  messages: [{ role: 'user', content: 'Reply OK only.' }],
  maxRetries: 0,
});

console.log(result.text);
console.log(result.usage.raw);
```

期望请求路径：

```text
https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/google/models/{model}:generateContent
```

期望验证字段：

```text
usage.raw.trafficType=ON_DEMAND_PRIORITY
```

如果返回 `ON_DEMAND`，说明调用链和 header 可以是正确的，但 Google 侧按标准 PayGo 处理了该次请求；需要结合限额、升速限制和实时容量判断。

## 日志识别

日志分三层，分别回答不同问题：

```text
[vertex-global:init] mode=project-global, project=unee-472712, location=global, auth=api-key, baseURL=https://aiplatform.googleapis.com/v1/projects/unee-472712/locations/global/publishers/google
```

这表示客户端走的是 project/global URL，不是 Express Mode。

```text
[buildTierHeaders] provider=vertex-global, tier=priority, requestType=shared applied for model=vertex-global:gemini-2.5-flash; verify actual routing via usage.raw.trafficType
```

这表示本模块已经按 spec 注入 Vertex PayGo headers。

```text
[LLM:end] id=vertex-priority-ping, method=generateText, model=vertex-global:gemini-2.5-flash, vertexTier=priority, vertexRequestType=shared, duration=1234ms, tokens=12 (in=9, out=3), trafficType=ON_DEMAND_PRIORITY
```

这条才是最终判定。`vertexTier=priority` / `vertexRequestType=shared` 说明请求意图，`trafficType=ON_DEMAND_PRIORITY` 说明 Google 实际按 Priority PayGo 处理。若同样请求返回 `trafficType=ON_DEMAND`，应视为标准 PayGo 或 Google 侧降级。

## 本地测试

聚焦测试：

```bash
bun test features/llm/clients/vertex-global.spec.ts features/llm/clients/llm.tier.spec.ts features/llm/clients/llm.tier.integration.spec.ts
```

环境变量 schema 测试：

```bash
bun test env/src/configure.spec.ts
```

类型检查：

```bash
bun run typecheck
```
