import { useEffect } from 'react';

export function useTheme(theme) {
  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  }, [theme]);
}
