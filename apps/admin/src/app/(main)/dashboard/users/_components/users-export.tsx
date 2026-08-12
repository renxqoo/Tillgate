"use client";

import { DownloadIcon } from "lucide-react";

import { Button } from "@ai-gateway/ui/components/ui/button";

import type { UserRow } from "../types";

export function UsersExport({ users }: { readonly users: ReadonlyArray<UserRow> }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        const lines = ["id\tsubject\temail\tdisplayName\tstatus\tbalance\trateCard"];
        for (const u of users) {
          lines.push(`${u.id}\t${u.subject}\t${u.email ?? ""}\t${u.displayName ?? ""}\t${u.status}\t${u.balance}\t${u.rateCardName ?? ""}`);
        }
        const blob = new Blob([lines.join("\n")], { type: "text/tab-separated-values" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `users-${new Date().toISOString().slice(0, 10)}.tsv`;
        a.click();
        URL.revokeObjectURL(url);
      }}
    >
      <DownloadIcon />
      Export
    </Button>
  );
}
