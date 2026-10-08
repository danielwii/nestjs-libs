/**
 * @app/llm-core/batch - OpenRouter Batch API 通用無狀態客戶端
 *
 * 設計哲學：
 * 1. 職責分離：libs 僅提供純粹、無狀態的 Batch SDK (LLMBatch)，不耦合任何 Redis / DB 或佇列機制。
 * 2. 雙階邊界防禦：
 *    - 靜態 Fail-Fast：要求 AI_OPENROUTER_API_KEY。
 *    - 動態 Safe-Reject：入境嚴格由 Zod Schema 驗證，並在本地即刻攔截重複的 custom_id，防範遠端靜默失敗。
 * 3. 單一真理源：靜態型別完全由 Zod 契約逆向派生。
 */

export * from './llm-batch.class';
export * from './schemas/batch.schema';
