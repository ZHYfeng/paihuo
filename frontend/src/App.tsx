import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, type ComponentType } from "react";
import { createBrowserRouter, Link, RouterProvider, useRouteError } from "react-router-dom";
import { AppShell } from "./components/shell";
import { Button, Card, Spinner, ToastProvider } from "./components/ui";

const DashboardPage = route(() => import("./pages/tasks"), "DashboardPage");
const BoardPage = route(() => import("./pages/tasks"), "BoardPage");
const HistoryPage = route(() => import("./pages/tasks"), "HistoryPage");
const TaskDetailPage = route(() => import("./pages/tasks"), "TaskDetailPage");
const ProjectsPage = route(() => import("./pages/resources"), "ProjectsPage");
const ProjectDetailPage = route(() => import("./pages/resources"), "ProjectDetailPage");
const RolesPage = route(() => import("./pages/resources"), "RolesPage");
const RuntimesPage = route(() => import("./pages/resources"), "RuntimesPage");
const SkillsPage = route(() => import("./pages/management"), "SkillsPage");
const TemplatesPage = route(() => import("./pages/management"), "TemplatesPage");
const SchedulesPage = route(() => import("./pages/management"), "SchedulesPage");
const SettingsPage = route(() => import("./pages/management"), "SettingsPage");
const SessionsPage = route(() => import("./pages/sessions"), "SessionsPage");
const SessionDetailPage = route(() => import("./pages/sessions"), "SessionDetailPage");
const WorkflowsPage = route(() => import("./pages/workflows"), "WorkflowsPage");
const WorkflowProposalPage = route(() => import("./pages/workflows"), "WorkflowProposalPage");
const WorkflowPlanPage = route(() => import("./pages/workflows"), "WorkflowPlanPage");

const router = createBrowserRouter([{
  path: "/",
  element: <AppShell />,
  errorElement: <RouteError />,
  children: [
    { index: true, element: <DashboardPage /> },
    { path: "board", element: <BoardPage /> },
    { path: "history", element: <HistoryPage /> },
    { path: "tasks/:id", element: <TaskDetailPage /> },
    { path: "projects", element: <ProjectsPage /> },
    { path: "projects/:id", element: <ProjectDetailPage /> },
    { path: "roles", element: <RolesPage /> },
    { path: "runtimes", element: <RuntimesPage /> },
    { path: "skills", element: <SkillsPage /> },
    { path: "templates", element: <TemplatesPage /> },
    { path: "schedules", element: <SchedulesPage /> },
    { path: "sessions", element: <SessionsPage /> },
    { path: "sessions/:id", element: <SessionDetailPage /> },
    { path: "workflows", element: <WorkflowsPage /> },
    { path: "workflow-proposals/:id", element: <WorkflowProposalPage /> },
    { path: "workflows/:id", element: <WorkflowPlanPage /> },
    { path: "settings", element: <SettingsPage /> },
    { path: "*", element: <NotFound /> }
  ]
}]);

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false }, mutations: { retry: false } } });

export default function App() {
  return <QueryClientProvider client={client}><ToastProvider><Suspense fallback={<Spinner label="加载页面" />}><RouterProvider router={router} /></Suspense></ToastProvider></QueryClientProvider>;
}

function route<T extends Record<string, unknown>, K extends keyof T>(loader: () => Promise<T>, name: K) {
  return lazy(async () => ({ default: (await loader())[name] as ComponentType }));
}

function NotFound() { return <Card className="mx-auto mt-20 max-w-xl text-center"><div className="text-5xl font-semibold text-brand-soft">404</div><h1 className="mt-4 text-xl font-semibold">页面不存在</h1><p className="mt-2 text-sm text-muted">地址可能已变更，返回工作台继续。</p><Link to="/"><Button variant="primary" className="mt-5">返回工作台</Button></Link></Card>; }

function RouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "页面加载失败";
  return <div className="grid min-h-screen place-items-center bg-canvas p-5 text-ink"><Card className="max-w-xl"><h1 className="text-xl font-semibold">出现错误</h1><p className="mt-3 text-sm text-danger">{message}</p><a href="/"><Button variant="primary" className="mt-5">重新进入平台</Button></a></Card></div>;
}
