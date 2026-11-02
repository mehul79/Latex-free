import type { AiProposalRecord, AiProposalStore } from "./contracts.js";
/** Suitable for isolated tests. Production uses PrismaAiProposalStore. */
export class MemoryAiProposalStore implements AiProposalStore {
  readonly records = new Map<string, AiProposalRecord>();
  async create(record: AiProposalRecord) {
    this.records.set(record.id, structuredClone(record));
  }
  async get(id: string) {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }
  async reject(id: string) {
    const record = this.records.get(id);
    if (!record || record.status !== "pending") return false;
    record.status = "rejected";
    return true;
  }
}
