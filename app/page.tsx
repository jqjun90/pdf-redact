'use client';

import type { ChangeEvent, DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { zipSync } from 'fflate';

type Redaction = {
  id: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type Draft = Omit<Redaction, 'id' | 'pageIndex'>;
type Tool = 'select' | 'redact';

const MAX_FILE_BYTES = 100 * 1024 * 1024;

function cleanBaseName(name: string) {
  return name.replace(/\.pdf$/i, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'redacted';
}

function pageFileName(base: string, page: number, pageCount: number) {
  const digits = Math.max(4, String(pageCount).length);
  return `${base}-page-${String(page).padStart(digits, '0')}.jpg`;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode this page.')), 'image/jpeg', quality);
  });
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Icon({ children }: { children: React.ReactNode }) {
  return <span className="tool-icon" aria-hidden="true">{children}</span>;
}

function PageCanvas({
  document,
  pageIndex,
  zoom,
  redactions,
  selectedId,
  tool,
  onAdd,
  onSelect,
}: {
  document: PDFDocumentProxy;
  pageIndex: number;
  zoom: number;
  redactions: Redaction[];
  selectedId: string | null;
  tool: Tool;
  onAdd: (redaction: Redaction) => void;
  onSelect: (id: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 612, height: 792 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;

    document.getPage(pageIndex + 1).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = page.getViewport({ scale: zoom });
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Canvas is unavailable.');
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setSize({ width: viewport.width, height: viewport.height });
      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      return renderTask.promise;
    }).then(() => {
      if (!cancelled) setRendering(false);
    }).catch((error: unknown) => {
      if (!cancelled && !(error instanceof Error && error.name === 'RenderingCancelledException')) setRendering(false);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, pageIndex, zoom]);

  function pointerPosition(event: ReactPointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  function startDrawing(event: ReactPointerEvent<SVGSVGElement>) {
    if (tool !== 'redact' || event.button !== 0) {
      if (tool === 'select') onSelect(null);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerPosition(event);
    startRef.current = point;
    setDraft({ x: point.x, y: point.y, width: 0, height: 0 });
    onSelect(null);
  }

  function continueDrawing(event: ReactPointerEvent<SVGSVGElement>) {
    if (!startRef.current) return;
    const point = pointerPosition(event);
    const start = startRef.current;
    setDraft({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  }

  function finishDrawing(event: ReactPointerEvent<SVGSVGElement>) {
    if (!startRef.current || !draft) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    startRef.current = null;
    setDraft(null);
    if (draft.width > 0.004 && draft.height > 0.004) {
      onAdd({ ...draft, id: crypto.randomUUID(), pageIndex });
    }
  }

  return (
    <article className="page-card" aria-label={`Page ${pageIndex + 1}`}>
      <div className="page-number">{pageIndex + 1}</div>
      <div className={`page-surface ${rendering ? 'is-rendering' : ''}`} style={{ width: size.width, height: size.height }}>
        <canvas ref={canvasRef} />
        <svg
          ref={overlayRef}
          className={`redaction-layer tool-${tool}`}
          viewBox={`0 0 ${size.width} ${size.height}`}
          preserveAspectRatio="none"
          onPointerDown={startDrawing}
          onPointerMove={continueDrawing}
          onPointerUp={finishDrawing}
          onPointerCancel={finishDrawing}
          aria-label={`Redaction layer for page ${pageIndex + 1}`}
        >
          {redactions.map((redaction) => (
            <rect
              key={redaction.id}
              className={`redaction-rect ${selectedId === redaction.id ? 'is-selected' : ''}`}
              x={redaction.x * size.width}
              y={redaction.y * size.height}
              width={redaction.width * size.width}
              height={redaction.height * size.height}
              onPointerDown={(event) => {
                event.stopPropagation();
                onSelect(redaction.id);
              }}
            />
          ))}
          {draft && (
            <rect
              className="redaction-draft"
              x={draft.x * size.width}
              y={draft.y * size.height}
              width={draft.width * size.width}
              height={draft.height * size.height}
            />
          )}
        </svg>
        {rendering && <div className="page-loading">Rendering page…</div>}
      </div>
    </article>
  );
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [tool, setTool] = useState<Tool>('redact');
  const [zoom, setZoom] = useState(1.1);
  const [redactions, setRedactions] = useState<Redaction[]>([]);
  const [past, setPast] = useState<Redaction[][]>([]);
  const [future, setFuture] = useState<Redaction[][]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportDpi, setExportDpi] = useState(150);
  const [notice, setNotice] = useState('');

  const commit = useCallback((next: Redaction[]) => {
    setRedactions((current) => {
      setPast((history) => [...history.slice(-49), current]);
      setFuture([]);
      return next;
    });
  }, []);

  const addRedaction = useCallback((redaction: Redaction) => {
    setRedactions((current) => {
      setPast((history) => [...history.slice(-49), current]);
      setFuture([]);
      return [...current, redaction];
    });
    setSelectedId(redaction.id);
  }, []);

  const undo = useCallback(() => {
    setPast((history) => {
      if (!history.length) return history;
      const previous = history[history.length - 1];
      setRedactions((current) => {
        setFuture((next) => [current, ...next].slice(0, 50));
        return previous;
      });
      setSelectedId(null);
      return history.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((history) => {
      if (!history.length) return history;
      const next = history[0];
      setRedactions((current) => {
        setPast((previous) => [...previous.slice(-49), current]);
        return next;
      });
      setSelectedId(null);
      return history.slice(1);
    });
  }, []);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    commit(redactions.filter((item) => item.id !== selectedId));
    setSelectedId(null);
  }, [commit, redactions, selectedId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault();
        deleteSelected();
      } else if (!command && event.key.toLowerCase() === 'r') {
        setTool('redact');
      } else if (!command && (event.key.toLowerCase() === 'v' || event.key === 'Escape')) {
        setTool('select');
        setSelectedId(null);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteSelected, redo, selectedId, undo]);

  async function openFile(nextFile?: File) {
    if (!nextFile) return;
    setError('');
    setNotice('');
    if (!(nextFile.type === 'application/pdf' || nextFile.name.toLowerCase().endsWith('.pdf'))) {
      setError('Choose a PDF file.');
      return;
    }
    if (nextFile.size > MAX_FILE_BYTES) {
      setError('This PDF is larger than the 100 MB limit.');
      return;
    }

    setLoading(true);
    try {
      if (pdf) await pdf.cleanup();
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const bytes = new Uint8Array(await nextFile.arrayBuffer());
      const loaded = await pdfjs.getDocument({ data: bytes }).promise;
      setFile(nextFile);
      setPdf(loaded);
      setRedactions([]);
      setPast([]);
      setFuture([]);
      setSelectedId(null);
    } catch (caught) {
      const message = caught instanceof Error && caught.name === 'PasswordException'
        ? 'Password-protected PDFs are not supported in this MVP.'
        : 'This PDF could not be opened. It may be damaged or unsupported.';
      setError(message);
      setPdf(null);
      setFile(null);
    } finally {
      setLoading(false);
    }
  }

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    void openFile(event.target.files?.[0]);
    event.target.value = '';
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void openFile(event.dataTransfer.files?.[0]);
  }

  async function exportJpgs() {
    if (!pdf || !file || exporting) return;
    setExporting(true);
    setExportProgress(0);
    setNotice('');
    setError('');
    try {
      const output: Record<string, Uint8Array> = {};
      const base = cleanBaseName(file.name);
      const scale = exportDpi / 72;

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas is unavailable.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: context, viewport }).promise;

        context.fillStyle = '#050505';
        for (const item of redactions.filter((redaction) => redaction.pageIndex === pageNumber - 1)) {
          const left = Math.max(0, Math.floor(item.x * canvas.width) - 2);
          const top = Math.max(0, Math.floor(item.y * canvas.height) - 2);
          const right = Math.min(canvas.width, Math.ceil((item.x + item.width) * canvas.width) + 2);
          const bottom = Math.min(canvas.height, Math.ceil((item.y + item.height) * canvas.height) + 2);
          context.fillRect(left, top, right - left, bottom - top);
        }

        const blob = await canvasToBlob(canvas, 0.92);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        output[pageFileName(base, pageNumber, pdf.numPages)] = bytes;
        canvas.width = 1;
        canvas.height = 1;
        setExportProgress(pageNumber / pdf.numPages);
      }

      const names = Object.keys(output);
      if (names.length === 1) {
        const jpg = output[names[0]];
        const jpgBuffer = jpg.buffer.slice(jpg.byteOffset, jpg.byteOffset + jpg.byteLength) as ArrayBuffer;
        downloadBlob(new Blob([jpgBuffer], { type: 'image/jpeg' }), names[0]);
        setNotice('Redacted JPG downloaded.');
      } else {
        const zipped = zipSync(output, { level: 0 });
        const zipBuffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
        downloadBlob(new Blob([zipBuffer], { type: 'application/zip' }), `${base}-redacted-jpgs.zip`);
        setNotice(`${names.length} redacted JPGs downloaded as a ZIP.`);
      }
    } catch {
      setError('Export failed. Try the standard quality setting or a smaller PDF.');
    } finally {
      setExporting(false);
    }
  }

  function closeDocument() {
    void pdf?.cleanup();
    setPdf(null);
    setFile(null);
    setRedactions([]);
    setPast([]);
    setFuture([]);
    setSelectedId(null);
    setNotice('');
    setError('');
  }

  if (!pdf) {
    return (
      <main className="app-shell">
        <header className="topbar">
          <div className="brand" aria-label="Blackline home"><span className="brand-mark" aria-hidden="true">B</span><span>Blackline</span></div>
          <div className="privacy-pill"><span aria-hidden="true">●</span> Files stay on your device</div>
        </header>
        <section className="hero">
          <p className="eyebrow">PRIVATE PDF REDACTION</p>
          <h1>Cover what matters.<br />Share only what should be seen.</h1>
          <p className="lede">Redact sensitive information directly in your browser, then export clean JPG images. Nothing is uploaded.</p>
          <div
            className={`dropzone ${dragging ? 'is-dragging' : ''}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <div className="file-glyph" aria-hidden="true"><span>PDF</span></div>
            <h2>{loading ? 'Opening your PDF…' : 'Drop your PDF here'}</h2>
            <p>or choose a file from your device</p>
            <button className="primary-button" type="button" disabled={loading} onClick={() => inputRef.current?.click()}>{loading ? 'Please wait…' : 'Choose PDF'}</button>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" onChange={onInput} hidden />
            <small>PDF only · Up to 100 MB</small>
          </div>
          {error && <p className="message error-message" role="alert">{error}</p>}
        </section>
        <footer className="home-footer">
          <span><b>1</b> Add a PDF</span><i aria-hidden="true" /><span><b>2</b> Draw redactions</span><i aria-hidden="true" /><span><b>3</b> Export JPGs</span>
        </footer>
      </main>
    );
  }

  return (
    <main className="editor-shell">
      <header className="editor-topbar">
        <button className="brand brand-button" type="button" onClick={closeDocument} aria-label="Close PDF and return home"><span className="brand-mark" aria-hidden="true">B</span><span>Blackline</span></button>
        <div className="document-title"><b>{file?.name}</b><span>{pdf.numPages} {pdf.numPages === 1 ? 'page' : 'pages'} · {redactions.length} {redactions.length === 1 ? 'redaction' : 'redactions'}</span></div>
        <button className="text-button" type="button" onClick={() => inputRef.current?.click()}>Replace PDF</button>
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" onChange={onInput} hidden />
      </header>

      <div className="editor-layout">
        <aside className="left-toolbar" aria-label="Editor tools">
          <button className={tool === 'select' ? 'active' : ''} type="button" onClick={() => setTool('select')} aria-pressed={tool === 'select'} title="Select (V)"><Icon>↖</Icon><span>Select</span></button>
          <button className={tool === 'redact' ? 'active' : ''} type="button" onClick={() => setTool('redact')} aria-pressed={tool === 'redact'} title="Redact (R)"><Icon>▰</Icon><span>Redact</span></button>
          <hr />
          <button type="button" onClick={undo} disabled={!past.length} title="Undo"><Icon>↶</Icon><span>Undo</span></button>
          <button type="button" onClick={redo} disabled={!future.length} title="Redo"><Icon>↷</Icon><span>Redo</span></button>
          <button type="button" onClick={deleteSelected} disabled={!selectedId} title="Delete selected"><Icon>×</Icon><span>Delete</span></button>
        </aside>

        <section className="document-workspace" aria-label="PDF pages">
          <div className="workspace-toolbar">
            <div className="hint"><span className="hint-icon">i</span>{tool === 'redact' ? 'Drag over anything you want to remove' : 'Select a redaction to delete it'}</div>
            <div className="zoom-control" aria-label="Zoom controls">
              <button type="button" onClick={() => setZoom((value) => Math.max(.55, +(value - .15).toFixed(2)))} aria-label="Zoom out">−</button>
              <span>{Math.round(zoom * 100)}%</span>
              <button type="button" onClick={() => setZoom((value) => Math.min(2, +(value + .15).toFixed(2)))} aria-label="Zoom in">+</button>
            </div>
          </div>
          <div className="pages-scroll">
            {Array.from({ length: pdf.numPages }, (_, pageIndex) => (
              <PageCanvas
                key={pageIndex}
                document={pdf}
                pageIndex={pageIndex}
                zoom={zoom}
                redactions={redactions.filter((item) => item.pageIndex === pageIndex)}
                selectedId={selectedId}
                tool={tool}
                onAdd={addRedaction}
                onSelect={setSelectedId}
              />
            ))}
          </div>
        </section>

        <aside className="export-panel">
          <div>
            <p className="panel-eyebrow">EXPORT</p>
            <h2>Make it permanent</h2>
            <p>Redactions are burned into fresh JPG pixels. The PDF text and metadata are not included.</p>
          </div>
          <div className="quality-field">
            <label htmlFor="quality">Image quality</label>
            <select id="quality" value={exportDpi} onChange={(event) => setExportDpi(Number(event.target.value))} disabled={exporting}>
              <option value={150}>Standard · 150 DPI</option>
              <option value={200}>High · 200 DPI</option>
              <option value={300}>Print · 300 DPI</option>
            </select>
          </div>
          <div className="export-summary">
            <span>Output</span>
            <b>{pdf.numPages === 1 ? '1 JPG image' : `${pdf.numPages} JPGs in a ZIP`}</b>
          </div>
          <button className="export-button" type="button" onClick={() => void exportJpgs()} disabled={exporting}>
            {exporting ? `Exporting ${Math.round(exportProgress * 100)}%` : 'Apply & export JPGs'}
          </button>
          {exporting && <div className="progress-track" role="progressbar" aria-valuenow={Math.round(exportProgress * 100)}><span style={{ width: `${exportProgress * 100}%` }} /></div>}
          {notice && <p className="message success-message" role="status">{notice}</p>}
          {error && <p className="message error-message" role="alert">{error}</p>}
          <div className="local-note"><span aria-hidden="true">●</span><div><b>Local processing</b><p>Your document never leaves this browser.</p></div></div>
        </aside>
      </div>
    </main>
  );
}
