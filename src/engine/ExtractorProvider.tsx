import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Directory, File, FileMode } from 'expo-file-system';
import { useSQLiteContext } from 'expo-sqlite';
import { ENGINE_HTML } from './engineHtml.generated';
import { bytesToBase64 } from '@/lib/base64';
import { guessLanguage } from '@/lib/text';
import { getBook, getFinishedSectionIdxs, getSampleText, getSectionTitles, insertSection, listBookIds, updateBook, type Book } from '@/db/database';
import { nextIndex } from '@/lib/translation';
import { notifyBooksChanged, setOcrProgress } from './booksEvents';
import { OCR_ASSETS, ocrAssetUri } from './ocrAssets';
import { translateBook } from './translateBook';

const CHUNK_BYTES = 384 * 1024;
// Pieces a ranged PDF's byte-range requests are answered in (the engine's pdf.js chunk size).
const RANGE_PIECE = 256 * 1024;

type EngineMessage =
  | { type: 'ready' }
  | { type: 'ack'; jobId: string }
  | { type: 'meta'; jobId: string; title: string | null; author: string | null; language: string | null; sectionCount: number }
  | { type: 'section'; jobId: string; index: number; title: string; text: string; needsOcr: boolean; ocr?: boolean }
  | { type: 'ocrNeeded'; jobId: string; count: number }
  | { type: 'ocrProgress'; jobId: string; done: number; total: number }
  | { type: 'log'; level: string; message: string }
  | { type: 'range'; jobId: string; begin: number; end: number }
  | { type: 'done' | 'cancelled'; jobId: string }
  | { type: 'error'; jobId: string; message: string };

type Stream = { onAck?: () => void; resolve: () => void; reject: (e: Error) => void };

type BookJob = {
  id: string;
  bookId: string;
  metaLanguage: string | null;
  writes: Promise<unknown>;
  // Photo books are recognised one page per job; this is the page the job is for.
  pageIndex?: number;
};

type ExtractorApi = {
  // Reads (or translates) a book, continuing from whatever an earlier, interrupted run already finished.
  enqueue: (bookId: string) => void;
  // The section being read: OCR and translation do it and the following ones first.
  focus: (bookId: string, sectionIdx: number) => void;
};

function makeDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const ExtractorContext = createContext<ExtractorApi | null>(null);

export function useExtractor() {
  const ctx = useContext(ExtractorContext);
  if (!ctx) throw new Error('useExtractor must be used inside ExtractorProvider');
  return ctx;
}

// Files of a book, in reading order: one file, or every page photo of a photo book.
function bookFiles(uri: string): File[] {
  const dir = new Directory(uri);
  if (dir.exists) {
    return dir
      .list()
      .filter((e): e is File => e instanceof File)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
  return [new File(uri)];
}

export function ExtractorProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const webRef = useRef<WebView<object>>(null);
  const [webKey, setWebKey] = useState(0);
  const ready = useRef(makeDeferred());
  const streams = useRef(new Map<string, Stream>());
  const active = useRef<BookJob | null>(null);
  const ocrLoaded = useRef<Promise<void> | null>(null);
  const queue = useRef<string[]>([]);
  const running = useRef(false);
  const translations = useRef<string[]>([]);
  const translating = useRef(false);
  const focusOf = useRef(new Map<string, number>());
  // File of each ranged PDF job, read from whenever the engine asks for bytes.
  const rangeFiles = useRef(new Map<string, { file: File; pending: Promise<void> }>());

  const inject = (js: string) => webRef.current?.injectJavaScript(`${js};true;`);

  // Streams files into the engine in acknowledged chunks; resolves when the engine reports the job done.
  const stream = useCallback((jobId: string, kind: string, files: File[], markEach: boolean, options?: object) => {
    const finished = new Promise<void>((resolve, reject) => {
      streams.current.set(jobId, { resolve, reject });
    });
    const send = async () => {
      const id = JSON.stringify(jobId);
      inject(`window.engine.begin(${id}, ${JSON.stringify(kind)}, ${JSON.stringify(options ?? {})})`);
      for (const file of files) {
        if (markEach) inject(`window.engine.mark(${id})`);
        const handle = file.open(FileMode.ReadOnly);
        try {
          for (;;) {
            const bytes = await handle.readBytes(CHUNK_BYTES);
            if (!bytes.length) break;
            const s = streams.current.get(jobId);
            if (!s) return;
            const acked = new Promise<void>((r) => (s.onAck = r));
            inject(`window.engine.chunk(${id}, "${bytesToBase64(bytes)}")`);
            await acked;
          }
        } finally {
          handle.close();
        }
      }
      inject(`window.engine.end(${id})`);
    };
    send().catch((e) => streams.current.get(jobId)?.reject(e as Error));
    return finished.finally(() => streams.current.delete(jobId));
  }, []);

  const loadOcr = useCallback(() => {
    if (!ocrLoaded.current) {
      ocrLoaded.current = (async () => {
        for (const name of OCR_ASSETS) {
          await stream(`asset-${name}-${Date.now()}`, `asset:${name}`, [new File(await ocrAssetUri(name))], false);
        }
      })();
      ocrLoaded.current.catch(() => {
        ocrLoaded.current = null;
      });
    }
    return ocrLoaded.current;
  }, [stream]);

  // Answers the engine's byte-range requests for a ranged PDF, one piece at a time and in order.
  const serveRange = useCallback((jobId: string, begin: number, end: number) => {
    const entry = rangeFiles.current.get(jobId);
    if (!entry) return;
    entry.pending = entry.pending.then(async () => {
      const handle = entry.file.open(FileMode.ReadOnly);
      try {
        for (let off = begin; off < end; off += RANGE_PIECE) {
          const s = streams.current.get(jobId);
          if (!s) return;
          handle.offset = off;
          const bytes = await handle.readBytes(Math.min(RANGE_PIECE, end - off));
          const acked = new Promise<void>((r) => (s.onAck = r));
          inject(`window.engine.range(${JSON.stringify(jobId)}, ${begin}, ${end}, ${off}, "${bytesToBase64(bytes)}")`);
          await acked;
        }
      } finally {
        handle.close();
      }
    });
    entry.pending.catch((e) => streams.current.get(jobId)?.reject(e as Error));
  }, []);

  // A PDF is not copied into the engine whole: the engine opens it by size and asks for the byte ranges it needs,
  // which keeps memory flat for books of hundreds of pages.
  const streamPdf = useCallback((jobId: string, file: File, options: object) => {
    const finished = new Promise<void>((resolve, reject) => {
      streams.current.set(jobId, { resolve, reject });
    });
    rangeFiles.current.set(jobId, { file, pending: Promise.resolve() });
    const id = JSON.stringify(jobId);
    inject(`window.engine.begin(${id}, "pdf", ${JSON.stringify({ ...options, length: file.size ?? 0 })})`);
    inject(`window.engine.end(${id})`);
    return finished.finally(() => {
      streams.current.delete(jobId);
      rangeFiles.current.delete(jobId);
    });
  }, []);

  // Photo books are recognised page by page, nearest to the page being read first, so a book of hundreds of
  // photos never has to be held in the engine at once and an interrupted run continues with the pages left.
  const processPhotos = useCallback(
    async (book: Book) => {
      const files = bookFiles(book.fileUri);
      const present = new Set((await getSectionTitles(db, book.id)).map((r) => r.idx));
      for (let i = 0; i < files.length; i++) {
        if (!present.has(i)) await insertSection(db, book.id, { idx: i, title: `Sayfa ${i + 1}`, text: '', ocr: 1 });
      }
      await updateBook(db, book.id, { section_count: files.length });
      notifyBooksChanged();
      const done = new Set(await getFinishedSectionIdxs(db, book.id));
      const total = files.length - done.size;
      let recognised = 0;
      setOcrProgress(book.id, { done: 0, total });
      for (;;) {
        const idx = nextIndex(files.length, done, focusOf.current.get(book.id) ?? 0);
        if (idx === null || !(await getBook(db, book.id))) return;
        const job: BookJob = { id: `${book.id}-${idx}-${Date.now()}`, bookId: book.id, metaLanguage: null, writes: Promise.resolve(), pageIndex: idx };
        active.current = job;
        await stream(job.id, 'images', [files[idx]], true);
        await job.writes;
        done.add(idx);
        setOcrProgress(book.id, { done: ++recognised, total });
      }
    },
    [db, stream],
  );

  const processBook = useCallback(
    async (bookId: string) => {
      const book = await getBook(db, bookId);
      if (!book) return;
      await updateBook(db, bookId, { status: 'processing', error: null });
      notifyBooksChanged();
      await ready.current.promise;

      const job: BookJob = { id: `${bookId}-${Date.now()}`, bookId, metaLanguage: null, writes: Promise.resolve() };
      active.current = job;
      try {
        const options = { skip: await getFinishedSectionIdxs(db, bookId), focus: focusOf.current.get(bookId) ?? 0 };
        if (book.format === 'images') await processPhotos(book);
        else if (book.format === 'pdf') await streamPdf(job.id, new File(book.fileUri), options);
        else await stream(job.id, book.format, bookFiles(book.fileUri), false, options);
        active.current = job;
        await job.writes;
        const sample = await getSampleText(db, bookId);
        await updateBook(db, bookId, { status: 'ready', language: guessLanguage(sample, job.metaLanguage) });
      } catch (e) {
        await job.writes.catch(() => {});
        await updateBook(db, bookId, { status: 'error', error: (e as Error).message || 'Bilinmeyen hata' });
      } finally {
        active.current = null;
        setOcrProgress(bookId, null);
        notifyBooksChanged();
      }
    },
    [db, stream, streamPdf, processPhotos],
  );

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        await processBook(queue.current.shift()!);
      }
    } finally {
      running.current = false;
    }
  }, [processBook]);

  const focus = useCallback((bookId: string, sectionIdx: number) => {
    focusOf.current.set(bookId, sectionIdx);
    const job = active.current;
    if (job?.bookId === bookId) inject(`window.engine.focus(${JSON.stringify(job.id)}, ${sectionIdx})`);
  }, []);

  // Translations run beside extraction: they follow their source book page by page while its OCR is still going.
  const pumpTranslations = useCallback(async () => {
    if (translating.current) return;
    translating.current = true;
    try {
      while (translations.current.length) {
        const bookId = translations.current[0];
        await updateBook(db, bookId, { status: 'processing', error: null });
        notifyBooksChanged();
        try {
          await translateBook(db, bookId, { focusOf: (id) => focusOf.current.get(id) ?? 0, focusSource: focus });
          await updateBook(db, bookId, { status: 'ready' });
        } catch (e) {
          await updateBook(db, bookId, { status: 'error', error: (e as Error).message || 'Çeviri yapılamadı.' });
        }
        translations.current.shift();
        notifyBooksChanged();
      }
    } finally {
      translating.current = false;
    }
  }, [db, focus]);

  const enqueue = useCallback(
    (bookId: string) => {
      void getBook(db, bookId).then((book) => {
        if (!book) return;
        if (book.format === 'translation') {
          if (!translations.current.includes(bookId)) translations.current.push(bookId);
          void pumpTranslations();
          return;
        }
        if (!queue.current.includes(bookId) && active.current?.bookId !== bookId) queue.current.push(bookId);
        void pump();
      });
    },
    [db, pump, pumpTranslations],
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const msg = JSON.parse(e.nativeEvent.data) as EngineMessage;
      if (msg.type === 'ready') {
        ready.current.resolve();
        return;
      }
      if (msg.type === 'log') {
        console.warn(`[engine] ${msg.message}`);
        return;
      }
      const s = streams.current.get(msg.jobId);
      if (msg.type === 'ack') {
        s?.onAck?.();
        return;
      }
      if (msg.type === 'done' || msg.type === 'cancelled') {
        s?.resolve();
        return;
      }
      if (msg.type === 'error') {
        s?.reject(new Error(msg.message));
        return;
      }
      if (msg.type === 'range') {
        serveRange(msg.jobId, msg.begin, msg.end);
        return;
      }
      const job = active.current;
      if (!job || msg.jobId !== job.id) return;
      // A photo-page job only contributes its recognised text, filed under the page it was started for.
      if (job.pageIndex !== undefined) {
        if (msg.type === 'section' && msg.ocr) {
          const idx = job.pageIndex;
          job.writes = job.writes.then(async () => {
            await insertSection(db, job.bookId, { idx, title: `Sayfa ${idx + 1}`, text: msg.text, ocr: msg.needsOcr ? 2 : 0 });
            notifyBooksChanged();
          });
        } else if (msg.type === 'ocrNeeded') {
          void loadOcr().then(
            () => inject(`window.engine.ocrStart(${JSON.stringify(job.id)}, true)`),
            () => inject(`window.engine.ocrStart(${JSON.stringify(job.id)}, false)`),
          );
        }
        return;
      }
      const write = (fn: () => Promise<unknown>) => {
        job.writes = job.writes.then(fn);
      };
      switch (msg.type) {
        case 'meta':
          job.metaLanguage = msg.language;
          write(async () => {
            const fields: Parameters<typeof updateBook>[2] = { section_count: msg.sectionCount };
            if (msg.title?.trim()) fields.title = msg.title.trim();
            if (msg.author?.trim()) fields.author = msg.author.trim();
            await updateBook(db, job.bookId, fields);
            notifyBooksChanged();
          });
          break;
        case 'section':
          write(async () => {
            const ocr = msg.ocr ? (msg.needsOcr ? 2 : 0) : msg.needsOcr ? 1 : 0;
            await insertSection(db, job.bookId, { idx: msg.index, title: msg.title, text: msg.text, ocr });
            notifyBooksChanged();
          });
          break;
        case 'ocrNeeded':
          setOcrProgress(job.bookId, { done: 0, total: msg.count });
          notifyBooksChanged();
          void loadOcr().then(
            () => inject(`window.engine.ocrStart(${JSON.stringify(job.id)}, true)`),
            () => inject(`window.engine.ocrStart(${JSON.stringify(job.id)}, false)`),
          );
          break;
        case 'ocrProgress':
          setOcrProgress(job.bookId, { done: msg.done, total: msg.total });
          break;
      }
    },
    [db, loadOcr, serveRange],
  );

  const onCrash = useCallback(() => {
    for (const s of streams.current.values()) {
      s.reject(new Error('Dosya işlenirken bellek yetersiz kaldı.'));
      s.onAck?.();
    }
    streams.current.clear();
    ocrLoaded.current = null;
    ready.current = makeDeferred();
    setWebKey((k) => k + 1);
  }, []);

  // Books still marked as processing were interrupted when the app closed; carry on with them.
  useEffect(() => {
    void listBookIds(db, { status: 'processing' }).then((ids) => ids.forEach(enqueue));
  }, [db, enqueue]);

  const api = useMemo(() => ({ enqueue, focus }), [enqueue, focus]);

  return (
    <ExtractorContext.Provider value={api}>
      {children}
      <View style={styles.hidden} pointerEvents="none">
        <WebView<object>
          key={webKey}
          ref={webRef}
          originWhitelist={['*']}
          source={{ html: ENGINE_HTML, baseUrl: 'https://engine.local/' }}
          javaScriptEnabled
          onMessage={onMessage}
          onContentProcessDidTerminate={onCrash}
          onRenderProcessGone={onCrash}
        />
      </View>
    </ExtractorContext.Provider>
  );
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0, left: -10, top: -10 },
});
