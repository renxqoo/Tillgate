"use client";

import { useState } from "react";

import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "@ai-gateway/ui/components/ui/button";

export interface CopyButtonProps {
  readonly text: string;
  readonly label?: string;
  readonly className?: string;
}

export function CopyButton({ text, label, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size={label ? "sm" : "icon"}
      variant="outline"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // fallback
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label="复制"
    >
      {copied ? <CheckIcon className="text-emerald-500" /> : <CopyIcon />}
      {label ? <span>{label}</span> : null}
    </Button>
  );
}
