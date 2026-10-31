import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { StatsStrip } from "./stats-strip";

vi.mock("../../lib/api", async importOriginal => ({ ...await importOriginal<typeof import("../../lib/api")>(), api: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

function renderStats() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><StatsStrip dashboard /></MemoryRouter></QueryClientProvider>);
  return client;
}

describe("工作台统计口径", () => {
  it("今天没有完成记录时显示零，不沿用昨天的完成数", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    vi.mocked(api).mockResolvedValue({ daily: [{ date: "2026-10-30", count: 7 }], status_counts: [] });
    const client = renderStats();
    await waitFor(() => expect(screen.getByRole("link", { name: /今日完成/ })).toHaveTextContent("今日完成0"));
    client.clear();
  });

  it("使用 UTC 日期取当天记录，执行队列不重复计入待审批任务", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T00:30:00+08:00"));
    vi.mocked(api).mockResolvedValue({
      in_flight: 5,
      daily: [{ date: "2026-10-29", count: 7 }, { date: "2026-10-30", count: 3 }],
      status_counts: [{ status: "queued", count: 1 }, { status: "running", count: 2 }, { status: "awaiting_review", count: 2 }]
    });
    const client = renderStats();
    await waitFor(() => expect(screen.getByRole("link", { name: /今日完成/ })).toHaveTextContent("今日完成3"));
    expect(screen.getByRole("link", { name: /执行队列/ })).toHaveTextContent("执行队列3");
    expect(screen.getByRole("link", { name: /待你审批/ })).toHaveTextContent("待你审批2");
    client.clear();
  });
});
