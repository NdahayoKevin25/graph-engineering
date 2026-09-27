import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../src/App';

it('renders the scaffold without remote resources', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Application ready' })).toBeInTheDocument();
});
