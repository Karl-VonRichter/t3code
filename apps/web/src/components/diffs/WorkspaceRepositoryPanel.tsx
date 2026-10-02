import type {
  ReviewDiffPreviewSource,
  ReviewDiffPreviewSourceKind,
  RepositoryWorkspace,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderGit2Icon,
  GitBranchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

function RepositoryChanges({
  repository,
  source,
  selected,
  selectedFilePath,
  onSelectFile,
}: {
  repository: RepositoryWorkspace["repositories"][number];
  source: ReviewDiffPreviewSource | undefined;
  selected: boolean;
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
}) {
  const files = useMemo(
    () => source?.files?.toSorted((a, b) => a.path.localeCompare(b.path)) ?? [],
    [source?.files],
  );
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [visibleCount, setVisibleCount] = useState(100);
  const open = expanded ?? files.length > 0;
  const ref = repository.branch ?? repository.checkoutSha?.slice(0, 12) ?? "No commits";
  return (
    <section aria-label={`${repository.path} changes`}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`${open ? "Collapse" : "Expand"} repository ${repository.path}`}
              aria-expanded={open}
              onClick={() => setExpanded(!open)}
              className={cn(
                "flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring",
                selected && "bg-accent/30",
              )}
            />
          }
        >
          {open ? (
            <ChevronDownIcon className="size-3 shrink-0" />
          ) : (
            <ChevronRightIcon className="size-3 shrink-0" />
          )}
          <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium">{repository.path}</span>
          <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
          <span className="max-w-28 truncate text-2xs text-muted-foreground">{ref}</span>
          <span
            className="min-w-5 rounded bg-muted px-1 text-center text-2xs tabular-nums"
            aria-label={`${files.length} changed files`}
          >
            {files.length}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="right">
          <p>
            {repository.path} · {repository.branch ?? "Detached HEAD"}
          </p>
          <p className="font-mono">{repository.checkoutSha ?? "No commits"}</p>
        </TooltipPopup>
      </Tooltip>
      {open && (
        <div className="pb-1">
          {files.length === 0 ? (
            <p className="py-1 pl-7 text-2xs text-muted-foreground">No changes</p>
          ) : (
            <ul>
              {files.slice(0, visibleCount).map((file) => {
                const localPath =
                  repository.path === "." ? file.path : file.path.slice(repository.path.length + 1);
                const slash = localPath.lastIndexOf("/");
                const name = localPath.slice(slash + 1);
                const directory = slash < 0 ? "" : localPath.slice(0, slash);
                return (
                  <li key={file.path}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label={`Review ${file.path}`}
                            aria-current={
                              selected && selectedFilePath === file.path ? "true" : undefined
                            }
                            onClick={() => onSelectFile(file.path)}
                            className={cn(
                              "flex w-full items-center gap-1.5 py-1 pl-7 pr-2 text-left text-xs hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring",
                              selected && selectedFilePath === file.path && "bg-accent",
                            )}
                          />
                        }
                      >
                        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 max-w-[60%] truncate">{name}</span>
                        <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                          {directory}
                        </span>
                        <span className="shrink-0 font-mono text-2xs tabular-nums text-success">
                          +{file.additions}
                        </span>
                        <span className="shrink-0 font-mono text-2xs tabular-nums text-error">
                          −{file.deletions}
                        </span>
                      </TooltipTrigger>
                      <TooltipPopup side="right">
                        {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                      </TooltipPopup>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          )}
          {files.length > visibleCount && (
            <div className="pl-7">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setVisibleCount((count) => count + 100)}
              >
                Show more files ({files.length - visibleCount} remaining)
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function WorkspaceRepositoryPanel({
  workspace,
  sources,
  sourceKind,
  selectedId,
  selectedFilePath,
  onSelect,
}: {
  workspace: RepositoryWorkspace;
  sources: ReadonlyArray<ReviewDiffPreviewSource>;
  sourceKind: ReviewDiffPreviewSourceKind;
  selectedId: string | undefined;
  selectedFilePath: string | null;
  onSelect: (id: string, filePath: string) => void;
}) {
  const { sourceByRepository, repositories } = useMemo(() => {
    const sourceByRepository = new Map(
      sources
        .filter((source) => source.kind === sourceKind && source.repository)
        .map((source) => [source.repository!.id, source]),
    );
    return {
      sourceByRepository,
      repositories: workspace.repositories.toSorted(
        (a, b) =>
          Number((sourceByRepository.get(b.id)?.files?.length ?? 0) > 0) -
          Number((sourceByRepository.get(a.id)?.files?.length ?? 0) > 0),
      ),
    };
  }, [workspace.repositories, sources, sourceKind]);
  return (
    <nav
      aria-label="Workspace repository changes"
      className="max-h-[45%] shrink-0 overflow-y-auto border-b border-border/70"
    >
      <div className="px-3 py-2 text-xs font-medium">
        {sourceKind === "working-tree" ? "Changes" : "Branch changes"}
      </div>
      {repositories.map((repository) => (
        <RepositoryChanges
          key={repository.id}
          repository={repository}
          source={sourceByRepository.get(repository.id)}
          selected={repository.id === selectedId}
          selectedFilePath={selectedFilePath}
          onSelectFile={(filePath) => onSelect(repository.id, filePath)}
        />
      ))}
      <p className="px-3 py-2 text-2xs text-muted-foreground">
        Checkpoints and isolated tasks across repositories are not available yet.
      </p>
    </nav>
  );
}
