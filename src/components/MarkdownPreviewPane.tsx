import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  path: string;
  content: string;
  loading: boolean;
  error: string | null;
};

export function MarkdownPreviewPane({ path, content, loading, error }: Props) {
  if (loading) {
    return (
      <div className="h-full min-h-0 w-full overflow-auto p-4">
        <div className="text-xs text-muted-foreground">Loading preview...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full min-h-0 w-full overflow-auto p-4">
        <div className="text-xs text-destructive">{error}</div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 w-full overflow-auto bg-background/30">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-6 py-5">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Preview · {path}
        </div>
        {content.trim().length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            This markdown file is empty.
          </div>
        ) : (
          <article className="text-sm leading-7 text-foreground">
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ node: _node, ...props }) => (
                  <h1
                    className="mb-4 mt-8 border-b pb-2 text-3xl font-semibold first:mt-0"
                    {...props}
                  />
                ),
                h2: ({ node: _node, ...props }) => (
                  <h2
                    className="mb-3 mt-8 border-b pb-2 text-2xl font-semibold first:mt-0"
                    {...props}
                  />
                ),
                h3: ({ node: _node, ...props }) => (
                  <h3
                    className="mb-2 mt-6 text-xl font-semibold first:mt-0"
                    {...props}
                  />
                ),
                h4: ({ node: _node, ...props }) => (
                  <h4
                    className="mb-2 mt-5 text-lg font-semibold first:mt-0"
                    {...props}
                  />
                ),
                p: ({ node: _node, ...props }) => (
                  <p className="my-4" {...props} />
                ),
                a: ({ node: _node, ...props }) => (
                  <a
                    className="text-primary underline underline-offset-2"
                    target="_blank"
                    rel="noreferrer"
                    {...props}
                  />
                ),
                ul: ({ node: _node, ...props }) => (
                  <ul className="my-4 list-disc pl-6" {...props} />
                ),
                ol: ({ node: _node, ...props }) => (
                  <ol className="my-4 list-decimal pl-6" {...props} />
                ),
                li: ({ node: _node, ...props }) => (
                  <li className="my-1" {...props} />
                ),
                blockquote: ({ node: _node, ...props }) => (
                  <blockquote
                    className="my-4 border-l-4 border-border pl-4 italic text-muted-foreground"
                    {...props}
                  />
                ),
                hr: ({ node: _node, ...props }) => (
                  <hr className="my-6 border-border" {...props} />
                ),
                table: ({ node: _node, ...props }) => (
                  <div className="my-4 overflow-x-auto">
                    <table
                      className="w-full border-collapse text-left text-sm"
                      {...props}
                    />
                  </div>
                ),
                th: ({ node: _node, ...props }) => (
                  <th
                    className="border border-border bg-muted/50 px-3 py-2 font-medium"
                    {...props}
                  />
                ),
                td: ({ node: _node, ...props }) => (
                  <td
                    className="border border-border px-3 py-2 align-top"
                    {...props}
                  />
                ),
                img: ({ node: _node, ...props }) => (
                  <img
                    className="my-4 max-w-full rounded-md border"
                    loading="lazy"
                    {...props}
                  />
                ),
                code: ({ node: _node, className, children, ...props }) => {
                  const isBlock =
                    typeof className === "string" &&
                    className.includes("language-");
                  if (isBlock) {
                    return (
                      <code className={className} {...props}>
                        {children}
                      </code>
                    );
                  }
                  return (
                    <code
                      className={[
                        "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em]",
                        className ?? "",
                      ].join(" ")}
                      {...props}
                    >
                      {children}
                    </code>
                  );
                },
                pre: ({ node: _node, ...props }) => (
                  <pre
                    className="my-4 overflow-x-auto rounded-md border bg-muted/60 p-4 font-mono text-[13px] leading-6"
                    {...props}
                  />
                ),
              }}
            >
              {content}
            </Markdown>
          </article>
        )}
      </div>
    </div>
  );
}
