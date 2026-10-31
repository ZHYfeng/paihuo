import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { RuntimesPage } from "./runtimes";

afterEach(() => vi.unstubAllGlobals());

it("shows credential confidence and native skills, then reloads both on refresh", async () => {
  let refreshed = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    let data: unknown;
    if (url === "/api/v1/runtimes/refresh") { refreshed = true; data = []; }
    else if (url === "/api/v1/runtimes") data = [{ id: "pi", name: "Pi", docs: "", capabilities: ["skills"], fields: [], healthy: true }];
    else if (url === "/api/v1/projects") data = [{ id: 2, name: "Example project" }];
    else if (url === "/api/v1/runtimes/provisioning") data = [{ id: "pi", name: "Pi", installed: true, login: true, auth: { status: refreshed ? "authenticated" : "configured", message: refreshed ? "CLI 已识别登录" : "已发现凭据配置；未验证服务端有效性" } }];
    else if (url === "/api/v1/runtimes/pi/skills") data = { runtime_id: "pi", skills: [{ name: refreshed ? "new-skill" : "package-skill", description: "Package skill", path: "/skills/package/SKILL.md", scope: "user", source: "Pi 包技能", enabled: false }], complete: true, warnings: [] };
    else if (url === "/api/v1/runtimes/pi/skills?project_id=2") data = { runtime_id: "pi", skills: [{ name: "project-skill", description: "Project skill", path: "/project/skills/SKILL.md", scope: "project", source: "项目技能", enabled: true }], complete: true, warnings: [] };
    else throw new Error(`Unexpected request ${url}`);
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ToastProvider><RuntimesPage /></ToastProvider></QueryClientProvider>);
  expect(await screen.findByText("已发现凭据配置；未验证服务端有效性")).toBeInTheDocument();
  expect(await screen.findByText("package-skill")).toBeInTheDocument();
  expect(screen.getByText("未加载")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /刷新/ }));
  expect(await screen.findByText("new-skill")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText("CLI 已识别登录")).toBeInTheDocument());
  fireEvent.change(screen.getByRole("combobox", { name: "技能范围" }), { target: { value: "2" } });
  expect(await screen.findByText("project-skill")).toBeInTheDocument();
  client.clear();
});
