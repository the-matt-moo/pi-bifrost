export const BIFROST_RPC_VERSION = 1;

export interface ClassifyTaskResult {
  readonly model: string | null;
  readonly thinking: { readonly level: string } | null;
}

export interface RpcReply {
  readonly version: number;
  readonly requestId: string;
  readonly success: boolean;
  readonly data?: ClassifyTaskResult;
  readonly error?: string;
}

interface RpcRequest {
  readonly version?: unknown;
  readonly requestId?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

export async function handleRpcRequest(
  raw: unknown,
  classifyTask: (text: string) => Promise<ClassifyTaskResult | null>,
): Promise<{ readonly requestId?: string; readonly reply?: RpcReply }> {
  if (!raw || typeof raw !== "object") return {};
  const request = raw as RpcRequest;
  const requestId = typeof request.requestId === "string" ? request.requestId : undefined;
  if (!requestId) return {};

  const fail = (error: string): { requestId: string; reply: RpcReply } => ({
    requestId,
    reply: { version: BIFROST_RPC_VERSION, requestId, success: false, error },
  });

  if (request.version !== BIFROST_RPC_VERSION) return fail("unsupported RPC version");
  if (request.method !== "classifyTask") return fail("unsupported RPC method");
  if (!request.params || typeof request.params !== "object") return fail("missing RPC parameters");
  const text = (request.params as { text?: unknown }).text;
  if (typeof text !== "string" || !text.trim()) return fail("missing task text");

  try {
    const data = await classifyTask(text.trim());
    return {
      requestId,
      reply: { version: BIFROST_RPC_VERSION, requestId, success: true, data: data ?? { model: null, thinking: null } },
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
