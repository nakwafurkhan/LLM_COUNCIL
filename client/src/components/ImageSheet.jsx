import { memo, useCallback, useRef, useState } from 'react';
import { Sheet } from './Sheet.jsx';
import { api } from '../lib/api.js';

export const ImageSheet = memo(function ImageSheet({ open, onClose, source, onPick }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState('Search for something, or upload an image, then ask about it.');
  const fileRef = useRef(null);

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setResults([]);
    setStatus('Searching…');
    try {
      const rows = await api.searchImages({ q, source });
      setResults(rows);
      setStatus(rows.length ? '' : 'Nothing found. Try different words.');
    } catch (err) {
      setStatus(`Search failed: ${err.message}`);
    }
  }, [query, source]);

  /* Uploads become data: URLs. Large photos make for slow first tokens, so this
     is best for screenshots rather than 12-megapixel originals. */
  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onPick({ url: reader.result, title: file.name });
    reader.readAsDataURL(file);
  };

  return (
    <Sheet open={open} title="Images" onClose={onClose}>
      <div className="searchbar">
        <input
          type="search"
          placeholder="Search openly-licensed images…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <button className="btn primary" onClick={search}>Search</button>
      </div>

      <div className="row" style={{ marginBottom: 13 }}>
        <button className="btn sm" onClick={() => fileRef.current?.click()}>Upload</button>
        <input type="file" accept="image/*" hidden ref={fileRef} onChange={onFile} />
        <span className="desc" style={{ margin: 0 }}>Tap a result to attach it to your next message.</span>
      </div>

      {status && <div className="empty">{status}</div>}

      <div className="imggrid">
        {results.map((image, i) => (
          <figure
            className="imgcell"
            key={`${image.url}-${i}`}
            style={{ animationDelay: `${i * 28}ms` }}
            tabIndex={0}
            role="button"
            onClick={() => onPick(image)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(image); }
            }}
          >
            <img src={image.thumb} alt={image.title} loading="lazy" />
            <figcaption>{image.title}{image.by ? ` · ${image.by}` : ''}</figcaption>
          </figure>
        ))}
      </div>
    </Sheet>
  );
});
