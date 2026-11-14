import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Backlog } from './Backlog';

test('Planned tasks has a one-line description under its title', () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}><MemoryRouter><Backlog /></MemoryRouter></QueryClientProvider>,
  );
  assert.match(html, /Planned tasks/);
  assert.match(html, /Tickets from your trackers and tasks you(&#x27;|')ve written\. Pick some and start them\./);
});
