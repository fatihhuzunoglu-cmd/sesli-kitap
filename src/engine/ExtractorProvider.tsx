import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Directory, File, FileMode } from 'expo-file-system';
import { useSQLiteContext } from 'expo-sqlite';
import { ENGINE_HTML } from './engineHtml.generated';
import { bytesToBase64 } from '@/lib/base64';
import { guessLanguage } from '@/lib/text';
import { clearSections, getBook, getSampleText, insertSection, updateBook } from '@/db/database';
import { notifyBooksChanged, setOcrProgress } from './booksEvents';
import { OCR_ASSETS, ocrAssetUri } from './ocrAssets';

const CHUNK_BYTES = 384 * 1024;

type EngineMessage =
  | { type: 'ready' }
  | { type: 'ack'; jobId: string }
  | { type: 'meta'; jobId: string; title: string | null; author: string | null; language: string | null; sectionCount: number }
  | { type: 'section'; jobId: string; index: number; title: string; text: string; needsOcr: boolean; ocr?: boolean }
  | { type: 'ocrNeeded'; jobId: string; count: number }
  | { type: 'ocrProgress'; jobId: string; done: number; total: number }
  | { type: 'done' | 'cancelled'; jobId: string }
  | { type: 'error'; jobId: string; message: string };

type Stream = { onAck?: () => void; resolve: () => void; reject: (e: Error) => void };

type BookJob = {
  id: string;
  bookId: string;
  metaLanguage: string | null;
  writes: Promise<unknown>;
};

type ExtractorApi = { enqueue: (bookId: string) => void };

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

  const inject = (js: string) => webRef.current?.injectJavaScript(`${js};true;`);

  // Streams files into the engine in acknowledged chunks; resolves when the engine reports the job done.
  const stream = useCallback((jobId: string, kind: string, files: File[], markEach: boolean) => {
    const finished = new Promise<void>((resolve, reject) => {
      streams.current.set(jobId, { resolve, reject });
    });
    const send = async () => {
      const id = JSON.stringify(jobId);
      inject(`window.engine.begin(${id}, ${JSON.stringify(kind)})`);
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

  const processBook = useCallback(
    async (bookId: string) => {
      const book = await getBook(db, bookId);
      if (!book) return;
      await clearSections(db, bookId);
      await updateBook(db, bookId, { status: 'processing', error: null });
      notifyBooksChanged();
      await ready.current.promise;

      const job: BookJob = { id: `${bookId}-${Date.now()}`, bookId, metaLanguage: null, writes: Promise.resolve() };
      active.current = job;
      try {
        await stream(job.id, book.format, bookFiles(book.fileUri), book.format === 'images');
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
    [db, stream],
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

  const enqueue = useCallback(
    (bookId: string) => {
      if (!queue.current.includes(bookId) && active.current?.bookId !== bookId) queue.current.push(bookId);
      void pump();
    },
    [pump],
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const msg = JSON.parse(e.nativeEvent.data) as EngineMessage;
      if (msg.type === 'ready') {
        ready.current.resolve();
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
      const job = active.current;
      if (!job || msg.jobId !== job.id) return;
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
            await insertSection(db, job.bookId, { idx: msg.index, title: msg.title, text: msg.text, needsOcr: msg.needsOcr });
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
    [db, loadOcr],
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

  useEffect(() => {
    void pump();
  }, [pump]);

  const api = useMemo(() => ({ enqueue }), [enqueue]);

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
