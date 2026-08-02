import { useState } from 'react';

/**
 * The "ship it" tab: the snippet a customer pastes into their own site.
 *
 * The widget is deliberately NOT `@kuralle-agents/widget`. That package speaks
 * to the chat router (`/api/agent/:id`, `/api/chat/*`); this example is built
 * on the deployment router, whose route and stream shape differ. Same product
 * idea, different wire contract — so the embed targets the contract in play.
 */
export function Embed(props: { token: string; agentId: string; published: boolean }) {
  const { token, agentId, published } = props;
  const [copied, setCopied] = useState(false);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  const snippet = [
    `<script src="${origin}/kuralle-agent.js"></script>`,
    `<kuralle-agent`,
    `  agent="${agentId}"`,
    `  token="${token}"`,
    `  title="Ask us anything"`,
    `></kuralle-agent>`,
  ].join('\n');

  return (
    <section>
      <h2>Embed</h2>
      <p className="muted">
        One script tag on the customer's site. No build step, no framework — a web
        component that talks to the same deployment route the preview uses, so its
        conversations appear in <strong>Observe</strong> pinned to whichever version
        was live when they started.
      </p>

      {!published && (
        <p className="warn">Publish a version first — the widget needs a released agent.</p>
      )}

      <pre>{snippet}</pre>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(snippet);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >{copied ? 'Copied' : 'Copy snippet'}</button>
      <a href="/embed-demo.html" target="_blank" rel="noreferrer">
        <button>Open the demo site ↗</button>
      </a>

      <h3>What it does for you</h3>
      <table>
        <tbody>
          <tr>
            <td>Thread id</td>
            <td>minted once per browser and kept in <code>localStorage</code>, so the
                conversation survives a reload</td>
          </tr>
          <tr>
            <td>Streaming</td>
            <td>reads the named-event SSE stream, buffering across chunk boundaries</td>
          </tr>
          <tr>
            <td>Idempotency</td>
            <td>one key per send, reused on retry so a blip cannot duplicate a turn</td>
          </tr>
          <tr>
            <td>Busy thread</td>
            <td><code>409</code> is shown as "still answering", not as an error</td>
          </tr>
        </tbody>
      </table>

      <h3>Before you ship this</h3>
      <p className="warn">
        The snippet above puts a <strong>tenant</strong> token in the browser. That is
        fine for a local demo and wrong in production: mint a short-lived, thread-scoped
        token server-side and hand the widget that instead. The widget code does not change.
      </p>
      <p className="muted">
        Also note an email is <strong>not</strong> a valid thread id — ids must match{' '}
        <code>^[a-zA-Z0-9][a-zA-Z0-9._:-]{'{0,127}'}$</code>, and <code>@</code> is outside
        that charset. Derive a safe id before passing one through from a webhook.
      </p>
    </section>
  );
}
