# 日志最佳实践

## 核心原则

**Tagged template 是类型信息的载体。** LogTape formatter 根据插值类型自动着色（number=黄, string=cyan, boolean=黄, object=inspect）。任何在 tagged template 之前把值合并为字符串的操作都会丢失类型信息。

## 两种着色方式（都合法）

| 方式 | 示例 | 着色时机 | 生产环境 |
|------|------|---------|---------|
| LogTape tagged template | `logger.info\`Port: ${port}\`` | formatter 渲染时 | 自动无色（JSON lines） |
| `f` tagged template | `f\`Port: ${port}\`` → `Effect.logInfo(result)` | 构建时（`r()` 着色） | `r()` 自动无色 |

**推荐 LogTape tagged template**（`logger.info\`...\``），因为：
- 不需要额外 import
- formatter 统一控制，生产环境自动切换
- 类型信息由 LogTape 原生保留

**`f` tagged template** 适用于 Effect 场景（`Effect.logInfo` 不支持 tagged template），或需要预构建消息的场景。

## 规则

### 1. 禁止 dedent / 模板字符串拼接吃掉类型

```typescript
// ❌ dedent 把所有插值合并为一个字符串，类型信息丢失
logger.info`${dedent`Port: ${port} Env: ${env}`}`;
// LogTape 收到: message = ['', '单个字符串', ''] → 无法按类型着色

// ❌ 模板字符串（不是 tagged template）也丢失类型
logger.info`${'Port: ' + port}`;

// ✅ 直接用 tagged template
logger.info`Port: ${port} Env: ${env}`;
// LogTape 收到: message = ['Port: ', 3700, ' Env: ', 'dev', ''] → number 黄色, string cyan
```

### 2. 多行日志用多次调用

```typescript
// ❌ 拼成一个大字符串
logger.info`${[line1, line2, line3].join('\n')}`;

// ✅ 逐行输出，每行保留类型信息
logger.info`Port: ${port}`;
logger.info`Env: ${env}`;
logger.info`PID: ${process.pid}`;
```

### 3. Banner / 启动日志用结构化逐行输出

```typescript
// ✅ LogTape tagged template — formatter 自动着色
logger.info`┌─ Config ──────────────────`;
logger.info`│ Port: ${port}`;
logger.info`│ Env: ${env} (isProd=${isProd})`;
logger.info`└─ Startup: ${duration}ms`;

// ✅ f tagged template + Effect.logInfo — 构建时着色（Effect 场景）
yield* Effect.logInfo(f`├─ HTTP: ${httpPort} | gRPC: ${grpcPort}`);
yield* Effect.logInfo(f`└─ Startup: ${elapsed}ms`);
```

### 4. Effect 日志

```typescript
// ❌ 模板字符串，类型丢失
yield* Effect.logInfo(`Port: ${port}`);

// ✅ 方案 A: f tagged template（推荐）
yield* Effect.logInfo(f`Port: ${port}`);

// ✅ 方案 B: 直接用 LogTape logger
const logger = getAppLogger('Module');
logger.info`Port: ${port}`;
```

### 5. 语义颜色只用于状态指示

```typescript
// ✅ 对勾/叉号、on/off 有语义，手动着色合理
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
logger.info`API_KEY=${hasKey ? green('✓') : red('✗')}`;

// ❌ 不要手动给普通值加色 — formatter/r() 会自动处理
logger.info`Port: ${cyan(String(port))}`;  // 多余
```

## 着色规则（devFormatter / r() 自动处理）

| 类型 | 颜色 | 示例 |
|------|------|------|
| number | 黄色 | `3700`, `78188` |
| string | cyan | `development`, `darwin` |
| boolean | 黄色 | `true`, `false` |
| null/undefined | dim | `null`, `undefined` |
| Error (error/fatal) | 红色 + stack | 完整堆栈 |
| Error (其他级别) | 仅 message | 无 stack |
| object | inspect 彩色 | `{ key: value }` |

## 生产环境

生产环境（`NODE_ENV=production`）自动切换：
- **devFormatter** → JSON lines（无 ANSI）
- **`r()`** → 纯文本 / JSON.stringify（无 ANSI）

代码无需条件判断。
