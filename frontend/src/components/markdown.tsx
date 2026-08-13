import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

marked.use({ gfm: true, breaks: false });

export function Markdown({ children }: { children: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(children) as string, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
    FORBID_ATTR: ["style", "onerror", "onclick", "onload"]
  }), [children]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
