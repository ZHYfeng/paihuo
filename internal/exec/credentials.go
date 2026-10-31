package exec

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

func configuredCredentials(source, method string) CredentialStatus {
	return CredentialStatus{Status: "configured", Source: source, Method: method, Message: "已发现凭据配置；未验证服务端有效性"}
}

func missingCredentials(source string) CredentialStatus {
	return CredentialStatus{Status: "missing", Source: source, Message: "未发现凭据配置"}
}

func invalidCredentials(source string) CredentialStatus {
	return CredentialStatus{Status: "invalid", Source: source, Message: "凭据文件格式无效"}
}

// 只读已知提供商的环境配置。不会执行凭据文件中的命令，也不会把值返回 API。
var piCredentialEnvKeys = []string{
	"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY",
	"XAI_API_KEY", "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY",
	"ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "MISTRAL_API_KEY", "MINIMAX_API_KEY", "MOONSHOT_API_KEY",
	"KIMI_API_KEY", "NVIDIA_API_KEY", "OPENCODE_API_KEY", "ANT_LING_API_KEY", "BASETEN_API_KEY", "META_API_KEY",
	"QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY",
}

func credentialEnvKeys(id string) []string {
	switch id {
	case "claude":
		return []string{"CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"}
	case "codex":
		return []string{"OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"}
	case "pi", "dsh":
		return piCredentialEnvKeys
	}
	return nil
}

func inspectFileCredentials(id string) CredentialStatus {
	for _, key := range credentialEnvKeys(id) {
		if strings.TrimSpace(os.Getenv(key)) != "" {
			return configuredCredentials("环境变量 "+key, "environment")
		}
	}
	var path string
	switch id {
	case "claude":
		path = filepath.Join(runtimeConfigDir("CLAUDE_CONFIG_DIR", ".claude"), ".credentials.json")
	case "codex":
		path = filepath.Join(runtimeConfigDir("CODEX_HOME", ".codex"), "auth.json")
	case "pi":
		path = filepath.Join(runtimeConfigDir("PI_CODING_AGENT_DIR", ".pi/agent"), "auth.json")
	case "dsh":
		path = filepath.Join(runtimeConfigDir("DSH_HOME", ".dsh"), ".credentials.yaml")
	default:
		return CredentialStatus{Status: "unknown", Message: "未提供凭据检测"}
	}
	if id == "dsh" && runtime.GOOS != "windows" {
		if info, err := os.Stat(path); err == nil && info.Mode().Perm()&0o077 != 0 {
			return CredentialStatus{Status: "invalid", Source: path, Message: "DSH 拒绝读取其他用户可访问的凭据文件；请设置权限为 600"}
		}
	}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		if id == "dsh" {
			return inspectDSHDotEnv()
		}
		return missingCredentials(path)
	}
	if err != nil {
		return CredentialStatus{Status: "unknown", Source: path, Message: "无法读取凭据配置"}
	}
	switch id {
	case "claude":
		var data struct {
			OAuth struct {
				Access  string  `json:"accessToken"`
				Refresh string  `json:"refreshToken"`
				Expires float64 `json:"expiresAt"`
			} `json:"claudeAiOauth"`
		}
		if json.Unmarshal(raw, &data) != nil {
			return invalidCredentials(path)
		}
		return oauthCredentials(path, data.OAuth.Access, data.OAuth.Refresh, data.OAuth.Expires)
	case "codex":
		var data struct {
			Key    string `json:"OPENAI_API_KEY"`
			Tokens struct {
				Access  string `json:"access_token"`
				Refresh string `json:"refresh_token"`
			} `json:"tokens"`
		}
		if json.Unmarshal(raw, &data) != nil {
			return invalidCredentials(path)
		}
		if strings.TrimSpace(data.Key) != "" {
			return configuredCredentials(path, "api_key")
		}
		return oauthCredentials(path, data.Tokens.Access, data.Tokens.Refresh, 0)
	case "pi":
		var entries map[string]storedCredential
		if json.Unmarshal(raw, &entries) != nil {
			return invalidCredentials(path)
		}
		result := missingCredentials(path)
		for _, entry := range entries {
			status := entry.status(path)
			if status.Status == "configured" {
				return status
			}
			if status.Status != "missing" {
				result = status
			}
		}
		return result
	case "dsh":
		return inspectDSHDocument(path, raw)
	}
	return missingCredentials(path)
}

type storedCredential struct {
	Type    string            `json:"type" yaml:"type"`
	Key     string            `json:"key" yaml:"key"`
	Env     map[string]string `json:"env" yaml:"env"`
	Access  string            `json:"access" yaml:"access"`
	Refresh string            `json:"refresh" yaml:"refresh"`
	Expires float64           `json:"expires" yaml:"expires"`
}

func (c storedCredential) status(path string) CredentialStatus {
	switch c.Type {
	case "api_key":
		if strings.HasPrefix(c.Key, "!") {
			return CredentialStatus{Status: "unknown", Source: path, Message: "凭据由外部命令提供，未执行验证"}
		}
		if strings.TrimSpace(c.Key) != "" || len(c.Env) > 0 {
			return configuredCredentials(path, "api_key")
		}
	case "oauth":
		return oauthCredentials(path, c.Access, c.Refresh, c.Expires)
	default:
		return invalidCredentials(path)
	}
	return missingCredentials(path)
}

func oauthCredentials(path, access, refresh string, expires float64) CredentialStatus {
	if strings.TrimSpace(access) == "" && strings.TrimSpace(refresh) == "" {
		return missingCredentials(path)
	}
	if expires > 0 && expires < float64(time.Now().UnixMilli()) && strings.TrimSpace(refresh) == "" {
		return CredentialStatus{Status: "expired", Source: path, Method: "oauth", Message: "凭据已过期且缺少刷新凭据"}
	}
	return configuredCredentials(path, "oauth")
}

func inspectDSHDocument(path string, raw []byte) CredentialStatus {
	var data map[string]any
	if yaml.Unmarshal(raw, &data) != nil {
		return invalidCredentials(path)
	}
	if len(data) == 0 {
		return inspectDSHDotEnv()
	}
	if version, ok := data["version"]; ok {
		if version != 1 {
			return invalidCredentials(path)
		}
		for key := range data {
			if key != "version" && key != "refs" && key != "records" {
				return invalidCredentials(path)
			}
		}
		found := false
		if refs, exists := data["refs"]; exists && refs != nil {
			values, ok := refs.(map[string]any)
			if !ok {
				return invalidCredentials(path)
			}
			for key, value := range values {
				if !validCredentialRef(key) {
					return invalidCredentials(path)
				}
				text, ok := value.(string)
				if !ok || strings.TrimSpace(text) == "" {
					return invalidCredentials(path)
				}
				found = true
			}
		}
		if records, exists := data["records"]; exists && records != nil {
			values, ok := records.(map[string]any)
			if !ok {
				return invalidCredentials(path)
			}
			for recordKey, value := range values {
				if !dshCredentialKey.MatchString(recordKey) {
					return invalidCredentials(path)
				}
				record, ok := value.(map[string]any)
				if !ok {
					return invalidCredentials(path)
				}
				switch record["kind"] {
				case "api-key":
					for field := range record {
						if field != "kind" && field != "key" && field != "env" {
							return invalidCredentials(path)
						}
					}
					if value, exists := record["key"]; exists {
						key, ok := value.(string)
						if !ok || strings.TrimSpace(key) == "" {
							return invalidCredentials(path)
						}
						found = true
					}
					if value, exists := record["env"]; exists {
						env, ok := value.(map[string]any)
						if !ok {
							return invalidCredentials(path)
						}
						for key, value := range env {
							text, ok := value.(string)
							if !validCredentialRef(key) || !ok || strings.TrimSpace(text) == "" {
								return invalidCredentials(path)
							}
							found = true
						}
					}
				case "grant":
					for field := range record {
						if field != "kind" && field != "payload" {
							return invalidCredentials(path)
						}
					}
					if _, exists := record["payload"]; !exists {
						return invalidCredentials(path)
					}
					if payload, ok := record["payload"].(map[string]any); ok && len(payload) > 0 {
						found = true
					}
				default:
					return invalidCredentials(path)
				}
			}
		}
		if found {
			return configuredCredentials(path, "credentials")
		}
		return inspectDSHDotEnv()
	}
	// 兼容 DSH 早期版本的平面凭据文件；空值和非字符串不会被误报。
	for key, value := range data {
		if !validCredentialRef(key) {
			return invalidCredentials(path)
		}
		text, ok := value.(string)
		if !ok || strings.TrimSpace(text) == "" {
			return invalidCredentials(path)
		}
	}
	return configuredCredentials(path, "credentials")
}

func validCredentialRef(key string) bool {
	if key == "" {
		return false
	}
	for i, char := range key {
		if char != '_' && (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (i == 0 || char < '0' || char > '9') {
			return false
		}
	}
	return true
}

var dshCredentialKey = regexp.MustCompile(`^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*$`)

func inspectDSHDotEnv() CredentialStatus {
	cwd, _ := os.Getwd()
	for _, path := range []string{filepath.Join(cwd, ".env"), filepath.Join(runtimeConfigDir("DSH_HOME", ".dsh"), ".env")} {
		file, err := os.Open(path)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(file)
		found := false
		for scanner.Scan() {
			line := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(scanner.Text()), "export "))
			key, value, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			value = strings.TrimSpace(value)
			if strings.HasPrefix(value, "\"") || strings.HasPrefix(value, "'") {
				quote := value[0]
				end := strings.IndexByte(value[1:], quote)
				if end < 0 {
					continue
				}
				value = value[1 : 1+end]
			} else if end := strings.IndexByte(value, '#'); end >= 0 {
				value = value[:end]
			}
			for _, known := range credentialEnvKeys("dsh") {
				if strings.TrimSpace(key) == known && strings.TrimSpace(value) != "" {
					found = true
				}
			}
		}
		_ = file.Close()
		if found {
			return configuredCredentials(path, "dotenv")
		}
	}
	return missingCredentials("")
}
