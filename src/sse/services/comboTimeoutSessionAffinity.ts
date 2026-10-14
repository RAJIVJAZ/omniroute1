import {
  evictSessionAccountAffinityForConnectionAsync,
  getSessionAffinityStore,
} from "@/lib/db/sessionAccountAffinity";
import { evictSessionAffinityOnComboTimeout } from "./sessionAffinityPin";
import { isComboPerModelTimeoutAbort } from "@omniroute/open-sse/services/combo/comboAbortReasons.ts";
import * as log from "../utils/logger";
import type { ComboTimeoutAffinityEvictionParams } from "./sessionAffinityPin";

/** Request-path helper: keep the legacy SQLite eviction and its logging synchronous. */
export function evictSessionAffinityOnComboTimeoutAsync(
  params: ComboTimeoutAffinityEvictionParams
): boolean | Promise<boolean> {
  if (getSessionAffinityStore().driver === "sqlite")
    return evictSessionAffinityOnComboTimeout(params);
  return evictRedisSessionAffinityOnComboTimeout(params);
}

async function evictRedisSessionAffinityOnComboTimeout(
  params: ComboTimeoutAffinityEvictionParams
): Promise<boolean> {
  const { sessionKey, provider, connectionId, modelAbortSignal } = params;
  if (!sessionKey || !provider || !connectionId || !isComboPerModelTimeoutAbort(modelAbortSignal))
    return false;
  try {
    const evicted = await evictSessionAccountAffinityForConnectionAsync(
      sessionKey,
      provider,
      connectionId
    );
    if (evicted)
      log.warn("AUTH", `Session account affinity evicted after ${provider} combo target timeout`);
    return evicted;
  } catch {
    // Local persistence failures are best-effort too; preserve the dispatch result.
    log.warn("AUTH", "Session affinity timeout eviction failed");
    return false;
  }
}
