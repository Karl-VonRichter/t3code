import { ChevronRightIcon } from "lucide-react";

export function CommitMessage({ message }: { message: string }) {
  return (
    <details className="group/commit-message text-xs">
      <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 group-open/commit-message:rotate-90"
        />
        Full commit message
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 font-mono text-xs text-foreground select-text">
        {message}
      </pre>
    </details>
  );
}
