import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const markdownComponents: Components = {
  a({ children, href }) {
    if (!href) {
      return <span>{children}</span>;
    }

    return (
      <a
        href={href}
        rel="noreferrer noopener"
        target="_blank"
      >
        {children}
      </a>
    );
  },
  img({ alt, src }) {
    if (!src) {
      return null;
    }

    return (
      <a
        className="markdown-message__image-link"
        href={src}
        rel="noreferrer noopener"
        target="_blank"
      >
        Image: {alt || 'Open source'}
      </a>
    );
  },
};

const markdownPlugins = [remarkGfm];

type MarkdownMessageProps = {
  content: string;
};

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
}: MarkdownMessageProps) {
  return (
    <div className="markdown-message">
      <Markdown
        components={markdownComponents}
        remarkPlugins={markdownPlugins}
        skipHtml
      >
        {content}
      </Markdown>
    </div>
  );
});
