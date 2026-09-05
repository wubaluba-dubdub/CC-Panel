/**
 * Part 1's whole client: one line of text and the resolved base path.
 *
 * Deliberately this small. This commit's job is to prove that the bundle is built, served
 * under the right prefix, executed under the shipped CSP, and able to read what
 * `bootstrap.js` put on the window — and if the operator reports a blank page at the end of
 * the milestone, this is the commit to bisect to. Everything else lands on top.
 *
 * The base path is rendered inside an LTR island: it is a secret-shaped token, and a token
 * that reverses on screen is unusable for the one thing the operator would do with it,
 * which is compare it with the URL bar.
 */
export function App(): React.JSX.Element {
  const base = window.__BASE__ ?? '(missing)';
  const locale = window.__LOCALE__ ?? '(missing)';

  return (
    <main className="boot">
      <h1>Claude Code Control Panel</h1>
      <p>The client bundle is served, executed, and reading the window.</p>
      <p>
        base path: <span className="ltr mono">{base}</span>
      </p>
      <p>
        locale: <span className="ltr mono">{locale}</span>
      </p>
    </main>
  );
}
