# nestjs-libs 迁移指南

本文档列出 nestjs-libs 中所有已废弃的 API，按优先级排列。每项包含变更原因、迁移步骤和代码示例。

> 所有废弃 API 当前仍可用，但不再维护。新代码**必须**使用新 API。

---

## 1. 环境变量：统一 `AI_` 前缀

**难度**: 低 | **影响面**: `.env` 文件

AI 相关环境变量统一加 `AI_` 前缀，消除与第三方 SDK 默认变量名的歧义。

| 废弃 | 替代 |
|------|------|
| `OPENROUTER_API_KEY` | `AI_OPENROUTER_API_KEY` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | `AI_GOOGLE_API_KEY` |
| `GOOGLE_VERTEX_API_KEY` | `AI_GOOGLE_VERTEX_API_KEY` |
| `OPENAI_API_KEY` | `AI_OPENAI_API_KEY` |

### 迁移步骤

1. `.env` 中添加新变量名，保留旧变量名
2. 确认服务正常后删除旧变量名
3. K8s ConfigMap / Secret 同步更新

### 检查命令

```bash
# 查找消费项目中的旧变量名
grep -rn 'OPENROUTER_API_KEY\|GOOGLE_GENERATIVE_AI_API_KEY\|GOOGLE_VERTEX_API_KEY\|OPENAI_API_KEY' \
  --include='*.env*' --include='*.yaml' --include='*.yml' --include='*.ts' \
  | grep -v 'AI_'
```

---

## 2. LLM Builder：`llm()` → `LLM` 静态类

**难度**: 低 | **影响面**: LLM 调用处

`llm()` builder 函数不带 tracing 和结构化日志。`LLM` 静态类统一了 observability。

### Before

```typescript
import { llm } from '@app/features/llm';

const { object } = await llm('openrouter:gemini-2.5-flash')
  .system('You are a helpful assistant')
  .user([{ type: 'text', text: 'Extract garment info' }])
  .generateObject(GarmentSchema);
```

### After

```typescript
import { LLM } from '@app/features/llm';

const { object } = await LLM.safeGenerateObject({
  id: 'extract-garment',
  model: 'openrouter:gemini-2.5-flash',
  schema: GarmentSchema,
  system: 'You are a helpful assistant',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Extract garment info' }] }],
}).match(
  (result) => result,
  (error) => { throw error; },
);
```

### 检查命令

```bash
grep -rn "llm('" --include='*.ts' | grep -v 'node_modules' | grep -v '.spec.ts'
```

---

## 3. LLM / Service 错误处理：内部层 Result，边界层显式收口

**难度**: 中 | **影响面**: 所有 LLM 调用与服务层错误处理

统一规范不是“全项目禁止 throw”，而是分两层：

- 内部层（service / orchestration / LLM 编排）：
  统一返回 `Result` / `ResultAsync<_, OopsError>`，用 `neverthrow` 表达可预期失败。
- 边界层（HTTP / GraphQL / gRPC / CLI / worker entry）：
  统一把 `Err(OopsError)` 收口为 `throw OopsError` 或协议响应。

`OopsError` 是全仓统一错误模型，`neverthrow` 只负责在内部层承载它，不负责跨框架协议传输。

| 旧设计 | 最终设计 |
|------|------|
| 内部层直接 `throw` | 内部层返回 `ResultAsync<_, OopsError>` |
| `LLM.generateObject()` 作为主实现 | `safe*` 作为主实现，`generate*` 仅作边界适配 |
| 裸 `Error` / `unknown` 四处传播 | 内部统一收敛为 `OopsError` |

### 适用范围

适合使用 `neverthrow + Oops`：

- `LLM` / AI 编排
- 需要 fallback / degrade / 聚合错误的 service
- 调用方需要自己决定“传播 / 降级 / 记录 / 合并”的业务流程

不适合使用 `neverthrow`：

- NestJS controller / resolver / guard / exception filter
- bootstrap / lifecycle / migration / shutdown
- 低层原语包装（如原生 `fetch` 兼容层）

这些属于边界或运行时控制流，继续 `throw OopsError` 或直接返回协议响应更自然。

### 标准写法

#### A. 内部层：链式传播（推荐）

```typescript
// service / orchestration layer
return LLM.safeGenerateObject({ id: 'task', model: key, schema, ... })
  .map(({ object }) => object);
```

#### B. 内部层：有明确业务降级时再 `unwrapOr`

```typescript
// 仅用于确实接受 fallback 值的场景
const value = await LLM.safeGenerateObject({...})
  .map(({ object }) => object)
  .unwrapOr(defaultValue);
```

#### C. 边界层：统一收口为 throw / response

```typescript
// controller / resolver / worker entry
const result = await LLM.safeGenerateObject({...});
const { object } = result.match(
  (value) => value,
  (error) => { throw error; },
);
```

#### D. Tool Calling 同理

```typescript
return LLM.safeGenerateObjectViaTool({
  id: 'task',
  model: key,
  schema,
  toolName: 'extract', toolDescription: 'Extract structured data',
  ...
}).map(({ object }) => object);
```

### 设计要求

- `safe*` 方法是单一真源；旧的 `generate*` 只做边界适配。
- fallback 最终失败时，`Err` 必须携带真实失败模型，不允许把错误误归因到初始 modelSpec。
- 所有错误工厂统一保留 `cause`，避免 Result 链路丢失原始异常。
- `unwrapOr` 只用于明确接受降级的业务场景，不能当作静默吞错。
- framework boundary 才允许 `match(... throw error)`。

### 反例

- 在 controller 里继续返回 `ResultAsync` 给 Nest 框架
- 在 service 中间层频繁 `match(... throw ...)` 再重新包装
- 用 `unwrapOr` 吞掉核心业务失败
- 在 fallback 结束后再用初始 modelSpec 重新猜错误来源

### 检查命令

```bash
# 查找边界层之外仍在直接使用 throws 版 LLM API 的调用
grep -rn 'LLM\.generateObject\b\|LLM\.generateObjectViaTool\b\|LLM\.generateText\b' --include='*.ts' \
  | grep -v 'node_modules' | grep -v '.spec.ts'
```

---

## 4. 异常系统：`IBusinessException` → `OopsError`

**难度**: 中 | **影响面**: 自定义异常类

`IBusinessException` 是 duck-typing 接口，没有基类约束，缺少 `errorCode` / `oopsCode` 结构化错误码。
`OopsError` 提供三级异常体系 + 工厂方法，与异常过滤器深度集成。

### 异常体系速查

| 类型 | 状态码 | 语义 | 日志 | Sentry |
|------|--------|------|------|--------|
| `Oops(...)` | 422 | 业务逻辑拒绝 | WARN | 否 |
| `Oops.Block(...)` | 400/401/403/404/409/429 | 请求被拦截 | WARN | 否 |
| `Oops.Panic(...)` | 500 | 系统故障 | ERROR | 是 |

### Before — 自定义 BusinessException

```typescript
import { IBusinessException } from '@app/nest';

class InsufficientBalanceException extends Error implements IBusinessException {
  readonly httpStatus = 422;
  readonly userMessage = '余额不足';
  getCombinedCode() { return '0x0103IB01'; }
  getInternalDetails() { return 'Balance insufficient for operation'; }
}

throw new InsufficientBalanceException();
```

### After — 使用 Oops 工厂方法

```typescript
import { Oops } from '@app/nest';

// 方式 A：使用内置工厂（通用场景）
throw Oops.Validation('余额不足', 'Balance insufficient for operation');

// 方式 B：自定义工厂（项目级，在 oops-factories 中声明）
throw Oops.InsufficientBalance(userId, required, available);

// 方式 C：直接构造（一次性场景）
throw new Oops({
  errorCode: '0x0103',
  oopsCode: 'IB01',
  userMessage: '余额不足',
  internalDetails: `userId=${userId} required=${required} available=${available}`,
});
```

### 内置工厂速查

```typescript
// ── 422 Oops ──
Oops.Validation(message, details?)
Oops.NotFound(resource, id?)
Oops.ExternalServiceExpected(provider, details?)

// ── 4xx Oops.Block ──
Oops.Block.Unauthorized(details?)          // 401
Oops.Block.Forbidden(resource?)            // 403
Oops.Block.NotFound(resource, id?)         // 404
Oops.Block.Conflict(details)               // 409
Oops.Block.RateLimited(resource, retryMs?) // 429
Oops.Block.AIModelRateLimited(model)       // 429

// ── 500 Oops.Panic ──
Oops.Panic.Database(operation, { cause? })
Oops.Panic.ExternalService(service, details?, { cause? })
Oops.Panic.Config(details, { cause? })
Oops.Panic.AIModelError(model, error, { cause? })
Oops.Panic.AIObjectGenerationFailed(model, finishReason, partialText?, { cause? })
```

### 兼容性说明

`AnyExceptionFilter` 同时支持 `OopsError` 和旧 `IBusinessException`（duck-typing `getCombinedCode()` + `httpStatus`），无需一次性全量迁移。

### 检查命令

```bash
# 查找仍 implements IBusinessException 的类
grep -rn 'IBusinessException\|BusinessException' --include='*.ts' \
  | grep -v 'node_modules' | grep -v 'nestjs-libs'
```

---

## 迁移顺序建议

```
1. 环境变量（5 分钟，零风险）
   ↓
2. llm() → LLM 静态类（逐文件替换，不改错误处理）
   ↓
3. generateObject → safeGenerateObject（需改调用方 Result 处理）
   ↓
4. BusinessException → Oops（渐进式，新代码用 Oops，旧代码按需迁移）
```

## 删除时间线

当所有消费项目完成迁移后，libs 侧将：

1. 删除 `env/src/configure.ts` 中 4 个旧环境变量属性
2. 删除 `features/llm/clients/auto.client.ts` 的 `llm()` 函数和 `LLMBuilder` 类
3. 删除 `LLM.generateObject()` 和 `LLM.generateObjectViaTool()`，将 `safe*` 方法 rename 为原名
4. 删除 `nest/src/exceptions/business-exception.interface.ts` 及其 re-export
