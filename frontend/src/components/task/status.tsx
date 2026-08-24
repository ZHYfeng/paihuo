import { Badge } from "../ui";
import { STATUS_LABEL } from "../../lib/taskmeta";

const statusTone: Record<string, "neutral" | "good" | "warn" | "bad" | "info"> = { queued: "neutral", claimed: "info", running: "info", awaiting_review: "warn", succeeded: "good", failed: "bad", cancelled: "neutral" };

export function TaskStatus({ status }: { status: string }) {
  return <Badge tone={statusTone[status] || "neutral"}>{STATUS_LABEL[status] || status}</Badge>;
}
