import { describe, expect, it } from 'vitest';
import { routes } from '../routes';

describe('scaffold', () => {
  it('routes the app root and room links', () => {
    expect(routes.map((route) => route.path)).toEqual(['/', '/room/:code']);
  });
});
