import type {
  ApproveRunInput,
  BridgeEvent,
  RunApprovalMode,
  SendRunMessageInput,
} from "@lingban/contracts";
import type { CodexSessionDiagnostics } from "../observability.js";

export interface AgentSession {
  start(): void | Promise<void>;
  setRuntimeEnv(env: Record<string, string>): void;
  setThreadConfig?(config: Record<string, unknown>): void;
  sendMessage(input: SendRunMessageInput): void | Promise<void>;
  approve(input: ApproveRunInput): void | Promise<void>;
  setApprovalMode(approvalMode: RunApprovalMode): void | Promise<void>;
  cancel(reason?: string): void | Promise<void>;
  heartbeat(): BridgeEvent;
  stop(): void | Promise<void>;
  getDiagnostics(): CodexSessionDiagnostics;
}
