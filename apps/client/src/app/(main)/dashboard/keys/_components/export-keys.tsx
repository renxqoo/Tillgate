"use client";

import { DownloadIcon } from "lucide-react";

import { Button } from "@ai-gateway/ui/components/ui/button";

import type { KeyRow } from "../types";

export function ExportKeys({ keys }: { readonly keys: ReadonlyArray<KeyRow> }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        const lines = ["name\tkeyPreview\tstatus\tcreatedAt"];
        for (const k of keys) {
          lines.push(`${k.name}\t${k.keyPreview}\t${k.status === 0 ? "active" : "revoked"}\t${k.createdAt}`);
        }
        const blob = new Blob([lines.join("\n")], { type: "text/tab-separated-values" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `api-keys-${new Date().toISOString().slice(0, 10)}.tsv`;
        a.click();
        URL.revokeObjectURL(url);
      }}
    >
      <DownloadIcon />
      Export
    </Button>
  );
}
