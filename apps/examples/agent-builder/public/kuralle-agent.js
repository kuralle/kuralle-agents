/**
 * <kuralle-agent> — a self-contained embeddable chat widget.
 *
 * One script tag on a customer's site, no build step, no framework:
 *
 *   <script src="https://your-host/kuralle-agent.js"></script>
 *   <kuralle-agent agent="support" token="demo-acme"></kuralle-agent>
 *
 * The stream is a standard AI SDK UIMessageStream — the same wire every
 * Kuralle runtime now speaks — so the frames are plain `data: {...}` chunks.
 * A React app would use `useChat` and write none of this; the parsing below
 * exists only because a drop-in <script> tag cannot assume a framework.
 *
 * TOKENS: this demo passes a tenant token straight to the browser, which is
 * fine for a local demo and wrong for production. A real deployment mints a
 * short-lived, thread-scoped token server-side and hands the widget that; the
 * widget code below does not change.
 */
(() => {
  const CSS = `
    :host { all: initial; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
    .panel { position: fixed; bottom: 84px; right: 20px; width: 360px; max-height: 60vh;
             display: none; flex-direction: column; background: #14161a; color: #e8eaed;
             border: 1px solid #2a2e35; border-radius: 12px; overflow: hidden;
             box-shadow: 0 12px 40px rgba(0,0,0,.45); }
    .panel.open { display: flex; }
    .head { padding: .7rem .9rem; border-bottom: 1px solid #2a2e35; font-weight: 600; }
    .head small { display: block; font-weight: 400; opacity: .55; font-size: .8em; }
    .log { flex: 1; overflow-y: auto; padding: .75rem .9rem; display: flex;
           flex-direction: column; gap: .55rem; }
    .msg { padding: .45rem .7rem; border-radius: .6rem; max-width: 85%; white-space: pre-wrap; }
    .msg.user { align-self: flex-end; background: #2f6fd0; color: #fff; }
    .msg.agent { align-self: flex-start; background: #22262d; }
    .msg.err { align-self: stretch; background: #3a2416; color: #f0b47a; font-size: .9em; }
    form { display: flex; gap: .4rem; padding: .6rem; border-top: 1px solid #2a2e35; }
    input { flex: 1; padding: .5rem .65rem; border-radius: .5rem; border: 1px solid #2a2e35;
            background: #0f1114; color: inherit; font: inherit; }
    button { font: inherit; border: 0; border-radius: .5rem; padding: .5rem .8rem;
             background: #2f6fd0; color: #fff; cursor: pointer; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .launcher { position: fixed; bottom: 20px; right: 20px; border-radius: 999px;
                padding: .7rem 1.1rem; box-shadow: 0 6px 20px rgba(0,0,0,.35); }
  `;

  class KuralleAgent extends HTMLElement {
    connectedCallback() {
      const agent = this.getAttribute('agent') ?? 'support';
      const token = this.getAttribute('token') ?? '';
      const base = (this.getAttribute('base') ?? '').replace(/\/+$/, '');
      const title = this.getAttribute('title') ?? 'Ask us anything';
      // One thread per browser, per agent. A real site keys this to its own
      // signed-in user id so the conversation follows them across devices.
      const key = `kuralle-thread:${agent}`;
      let threadId = localStorage.getItem(key);
      if (!threadId) {
        threadId = `web-${crypto.randomUUID()}`;
        localStorage.setItem(key, threadId);
      }

      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>${CSS}</style>
        <button class="launcher" part="launcher">Chat</button>
        <section class="panel">
          <div class="head">${title}<small>agent: ${agent} · thread: ${threadId.slice(0, 16)}…</small></div>
          <div class="log"></div>
          <form><input placeholder="Type a message…" /><button type="submit">Send</button></form>
        </section>`;

      const panel = root.querySelector('.panel');
      const log = root.querySelector('.log');
      const form = root.querySelector('form');
      const input = root.querySelector('input');
      const send = form.querySelector('button');

      root.querySelector('.launcher').addEventListener('click', () => {
        panel.classList.toggle('open');
        if (panel.classList.contains('open')) input.focus();
      });

      const add = (cls, text) => {
        const el = document.createElement('div');
        el.className = `msg ${cls}`;
        el.textContent = text;
        log.append(el);
        log.scrollTop = log.scrollHeight;
        return el;
      };

      form.addEventListener('submit', async event => {
        event.preventDefault();
        const message = input.value.trim();
        if (!message) return;
        input.value = '';
        add('user', message);
        send.disabled = true;

        // One key per logical send. A retry MUST reuse it, or a network blip
        // becomes a duplicated turn.
        const idempotencyKey = crypto.randomUUID();
        let bubble = null;
        try {
          const response = await fetch(
            `${base}/v1/agents/${encodeURIComponent(agent)}/threads/${encodeURIComponent(threadId)}/messages`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'idempotency-key': idempotencyKey,
              },
              body: JSON.stringify({ message }),
            },
          );
          if (response.status === 409) { add('err', 'One moment — still answering.'); return; }
          if (!response.ok || !response.body) { add('err', `Sorry, something failed (${response.status}).`); return; }

          const take = frame => {
            const data = frame.match(/^data: (.*)$/m)?.[1]?.trim();
            // `[DONE]` is the AI SDK's stream sentinel, not JSON.
            if (!data || data === '[DONE]') return;
            let chunk;
            try { chunk = JSON.parse(data); } catch { return; }
            if (chunk.type !== 'text-delta' || typeof chunk.delta !== 'string') return;
            if (!bubble) bubble = add('agent', '');
            bubble.textContent += chunk.delta;
            log.scrollTop = log.scrollHeight;
          };

          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += value;
            // Chunk boundaries do not respect SSE frame boundaries; keep the
            // trailing partial frame for the next read.
            const frames = buffer.split('\n\n');
            buffer = frames.pop() ?? '';
            for (const frame of frames) take(frame);
          }
          // Flush a final frame the server did not terminate with a blank
          // line. Standard SSE always does, so this is belt-and-braces —
          // borrowed from Algolia's ai-lite parser, which handles it too.
          if (buffer.trim()) take(buffer);
          if (!bubble) add('err', 'No reply received.');
        } catch (error) {
          add('err', `Network error: ${error.message}`);
        } finally {
          send.disabled = false;
          input.focus();
        }
      });
    }
  }

  if (!customElements.get('kuralle-agent')) {
    customElements.define('kuralle-agent', KuralleAgent);
  }
})();
