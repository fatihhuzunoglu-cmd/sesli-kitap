import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { File, FileMode } from 'expo-file-system';
import { useSQLiteContext } from 'expo-sqlite';
import { ENGINE_HTML } from './engineHtml.generated';
import { bytesToBase64 } from '@/lib/base64';
import { guessLanguage } from '@/lib/text';
import { clearSections, getBook, getSampleText, insertSection, updateBook, type Book } from '@/db/database';
import { notifyBooksChanged } from './booksEvents';

const CHUNK_BYTES = 384 * 1024;

type EngineMessage =
  | { type: 'ready' }
  | { type: 'ack'; jobId: string }
  | { type: 'meta'; jobId: string; title: string | null; author: string | null; language: string | null; sectionCount: number }
  | { type: 'section'; jobId: string; index: number; title: string; text: string; needsOcr: boolean }
  | { type: 'done' | 'cancelled'; jobId: string }
  | { type: 'error'; jobId: string; message: string };

type ActiveJob = {
  id: string;
  bookId: string;
  metaLanguage: string | null;
  writes: Promise<unknown>;
  onAck?: () => void;
  resolve: () => void;
  reject: (e: Error) => void;
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

export function ExtractorProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const webRef = useRef<WebView<object>>(null);
  const [webKey, setWebKey] = useState(0);
  const ready = useRef(makeDeferred());
  const active = useRef<ActiveJob | null>(null);
  const queue = useRef<string[]>([]);
  const running = useRef(false);

  const inject = (js: string) => webRef.current?.injectJavaScript(`${js};true;`);

  const sendFile = useCallback(async (job: ActiveJob, book: Book) => {
    const handle = new File(book.fileUri).open(FileMode.ReadOnly);
    try {
      inject(`window.engine.begin(${JSON.stringify(job.id)}, ${JSON.stringify(book.format)})`);
      for (;;) {
        const bytes = await handle.readBytes(CHUNK_BYTES);
        if (!bytes.length) break;
        const acked = new Promise<void>((r) => (job.onAck = r));
        inject(`window.engine.chunk(${JSON.stringify(job.id)}, "${bytesToBase64(bytes)}")`);
        await acked;
      }
      inject(`window.engine.end(${JSON.stringify(job.id)})`);
    } finally {
      handle.close();
    }
  }, []);

  const processBook = useCallback(
    async (bookId: string) => {
      const book = await getBook(db, bookId);
      if (!book) return;
      await clearSections(db, bookId);
      await updateBook(db, bookId, { status: 'processing', error: null });
      notifyBooksChanged();
      await ready.current.promise;

      const done = new Promise<void>((resolve, reject) => {
        active.current = {
          id: `${bookId}-${Date.now()}`,
          bookId,
          metaLanguage: null,
          writes: Promise.resolve(),
          resolve,
          reject,
        };
      });
      const job = active.current!;
      try {
        await sendFile(job, book);
        await done;
        await job.writes;
        const sample = await getSampleText(db, bookId);
        await updateBook(db, bookId, { status: 'ready', language: guessLanguage(sample, job.metaLanguage) });
      } catch (e) {
        await job.writes.catch(() => {});
        await updateBook(db, bookId, { status: 'error', error: (e as Error).message || 'Bilinmeyen hata' });
      } finally {
        active.current = null;
        notifyBooksChanged();
      }
    },
    [db, sendFile],
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
      const job = active.current;
      if (!job || msg.jobId !== job.id) return;
      const write = (fn: () => Promise<unknown>) => {
        job.writes = job.writes.then(fn);
      };
      switch (msg.type) {
        case 'ack':
          job.onAck?.();
          break;
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
        case 'done':
        case 'cancelled':
          job.resolve();
          break;
        case 'error':
          job.reject(new Error(msg.message));
          break;
      }
    },
    [db],
  );

  const onCrash = useCallback(() => {
    active.current?.reject(new Error('Dosya işlenirken bellek yetersiz kaldı.'));
    active.current?.onAck?.();
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
