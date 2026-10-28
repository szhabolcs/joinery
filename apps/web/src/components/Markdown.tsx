/**
 * Comment markdown rendering: `react-markdown` + `remark-gfm`, with
 * fenced code blocks highlighted through Pierre's shared highlighter (the
 * diff's own, see lib/workerPool.tsx) rather than pulling in a second one.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getHighlighterIfLoaded, getSharedHighlighter, type DiffsHighlighter } from '@pierre/diffs';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PREFERRED_HIGHLIGHTER } from '../lib/workerPool.tsx';
import { useTheme } from '../state/ThemeContext.tsx';

/** Highlighted HTML, or null for a language the highlighter can't do. */
function toHtml(highlighter: DiffsHighlighter, code: string, lang: string, theme: string): string | null {
  try {
    return highlighter.codeToHtml(code, { lang, theme });
  } catch {
    return null;
  }
}

/**
 * Highlighted during render when the highlighter already has the theme and
 * language, so the block's first paint is its last (a hover card sizes to it
 * and would jump); only a cold start waits a frame or more on the plain one.
 */
function CodeBlock({
  className,
  children,
}: {
  className: string | undefined;
  children?: ReactNode;
}): React.JSX.Element {
  const lang = /language-(\w+)/.exec(className ?? '')?.[1] ?? 'text';
  const code = typeof children === 'string' ? children : String(children ?? '');
  const [late, setLate] = useState<string | null>(null);
  const { chromeMode, diffTheme } = useTheme();
  const theme = chromeMode === 'dark' ? diffTheme.dark : diffTheme.light;

  const loaded = getHighlighterIfLoaded({ theme, lang });
  // undefined: not loaded yet; null: loaded, but this language can't be highlighted.
  const now = useMemo(
    () => (loaded === undefined ? undefined : toHtml(loaded, code, lang, theme)),
    [loaded, code, lang, theme],
  );

  useEffect(() => {
    if (now !== undefined) return;
    let cancelled = false;
    getSharedHighlighter({ themes: [theme], langs: [lang], preferredHighlighter: PREFERRED_HIGHLIGHTER })
      .then((highlighter) => {
        if (!cancelled) setLate(toHtml(highlighter, code, lang, theme));
      })
      .catch(() => {
        if (!cancelled) setLate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [now, code, lang, theme]);

  const html = now ?? late;
  if (html !== null) {
    // eslint-disable-next-line react/no-danger -- highlighter output, not user HTML.
    return <div className="thread-code-block text-xs" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  // The same box as the highlighted block, so swapping one for the other only changes colours.
  return (
    <div className="thread-code-block text-xs">
      <pre className="bg-chrome-bg-sunken">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// Body-scale prose (13px) with secondary-scale (12px) inline/fenced code, per
// the shared type scale — this renders both in the narrow reading-order
// panel (as step explanations, sized down to `text-xs` by that caller) and
// in thread bodies, so it needs to look right at both its own default size
// and when a caller overrides it smaller.
export function Markdown({ children, className = '' }: { children: string; className?: string }): React.JSX.Element {
  return (
    <div className={`prose-sm max-w-none text-body leading-relaxed text-chrome-fg [&_a]:text-chrome-accent [&_code]:text-xs [&_p]:my-1 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children: codeChildren }) {
            const isBlock = className?.includes('language-') ?? false;
            if (!isBlock) {
              return <code className="rounded bg-chrome-bg-sunken px-1 py-0.5">{codeChildren}</code>;
            }
            return <CodeBlock className={className}>{codeChildren}</CodeBlock>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
