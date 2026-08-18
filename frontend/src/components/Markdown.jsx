import React, { Suspense, lazy, memo } from 'react';

// react-markdown + remark-gfm are the heaviest dependency in the app and are
// only needed once an answer exists, so they load on demand rather than
// blocking first paint.
const Renderer = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }] = await Promise.all([
    import('react-markdown'),
    import('remark-gfm'),
  ]);
  const Component = ({ children }) => (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
  );
  return { default: Component };
});

// While the chunk is in flight we show the raw text rather than a spinner: it is
// already readable, and the swap to formatted output is not jarring.
function Markdown({ children }) {
  const text = children || '';
  return (
    <div className="md">
      <Suspense fallback={<div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>}>
        <Renderer>{text}</Renderer>
      </Suspense>
    </div>
  );
}

export default memo(Markdown);
