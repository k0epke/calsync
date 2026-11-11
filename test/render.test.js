import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard, layout } from '../lib/render.js';

test('disconnect form carries the stamped CSRF token', () => {
  const { body } = renderDashboard({
    pairs: [],
    google: { configured: true, connected: true, email: 'x@example.com', redirectUrl: 'https://kalsync.koepke.tech/oauth/callback' },
    csrf: 'TOK123',
  });
  const line = body.split('\n').find((l) => l.includes('action="/oauth/disconnect"'));
  assert.ok(line, 'disconnect form rendered');
  assert.match(line, /name="_csrf" value="TOK123"/);
});

test('logout form in layout carries the CSRF token', () => {
  const html = layout({ title: 't', body: '<p>hi</p>', user: 'admin', csrf: 'TOK456' });
  const line = html.split('\n').find((l) => l.includes('action="/logout"'));
  assert.ok(line, 'logout form rendered');
  assert.match(line, /name="_csrf" value="TOK456"/);
});

test('layout tolerates missing csrf (empty token rendered)', () => {
  const html = layout({ title: 't', body: '', user: 'admin' });
  assert.match(html, /name="_csrf" value=""/);
});
