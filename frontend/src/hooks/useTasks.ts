import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../components/ui";
import { api, keys } from "../lib/api";
import type { Task } from "../types";

export function useTasks(query = "") {
  return useQuery({ queryKey: [...keys.tasks, query], queryFn: () => api<Task[]>(`/tasks${query}`), refetchInterval: 15_000 });
}

export function useTaskStatusMutation() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, status, revision }: { id: number; status: string; revision: number }) => api(`/tasks/${id}`, { method: "PATCH", revision, body: { status } }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: keys.tasks }); queryClient.invalidateQueries({ queryKey: keys.stats }); toast("已更新"); },
    onError: error => toast((error as Error).message, "bad")
  });
}

/* ---- 统计条（工作台 4 项 / 看板 6 项，旧 main.js renderStatsStrip） ---- */
