import type { ProvisionInfo } from "../types";

export function credentialLabel(runtime: ProvisionInfo): string {
  switch (runtime.auth?.status) {
    case "authenticated": return "CLI 已识别登录";
    case "configured": return "已配置凭据";
    case "missing": return "未发现凭据";
    case "invalid": return "凭据格式无效";
    case "expired": return "凭据已过期";
    default: return "凭据状态未知";
  }
}
