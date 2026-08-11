import { memo } from 'react';

export const Toast = memo(function Toast({ message }) {
  return <div className={`toast${message ? ' on' : ''}`}>{message}</div>;
});
