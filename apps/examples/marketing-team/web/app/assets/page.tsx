'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface AssetRow {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

export default function AssetsPage() {
  const [assets, setAssets] = useState<AssetRow[]>();
  const [error, setError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/assets');
    const body = (await response.json()) as { assets?: AssetRow[]; error?: string };
    if (!response.ok) {
      setError(body.error ?? 'Could not load assets.');
      return;
    }
    setAssets(body.assets ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      setError(undefined);
      try {
        const contentBase64 = await fileToBase64(file);
        const response = await fetch('/api/assets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64 }),
        });
        const body = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Upload failed.');
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [load],
  );

  const remove = useCallback(
    async (id: string) => {
      setError(undefined);
      const response = await fetch(`/api/assets/${id}`, { method: 'DELETE' });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? 'Delete failed.');
        return;
      }
      await load();
    },
    [load],
  );

  return (
    <main className="page">
      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Assets</h1>
        <label className="btn btn--primary">
          {uploading ? 'Uploading…' : 'Upload'}
          <input
            ref={inputRef}
            type="file"
            style={{ display: 'none' }}
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
      </div>

      {error ? (
        <p className="status-message" data-tone="error">
          {error}
        </p>
      ) : null}

      <div className="card asset-list">
        {assets?.map((asset) => (
          <div key={asset.id} className="asset-row">
            <div>
              <strong>{asset.filename}</strong>
              <p className="status-message" style={{ margin: 0 }}>
                {asset.mimeType} · {(asset.sizeBytes / 1024).toFixed(1)} KB
              </p>
            </div>
            <button type="button" className="btn" onClick={() => void remove(asset.id)}>
              Delete
            </button>
          </div>
        ))}
        {assets && assets.length === 0 ? <p className="status-message">No assets yet.</p> : null}
      </div>
    </main>
  );
}
