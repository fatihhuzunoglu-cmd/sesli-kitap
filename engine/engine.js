// Runs inside the hidden extractor WebView. Receives a book file in base64 chunks and posts its text back section by section.
(function () {
  'use strict';

  // pdf.js reads text with `for await` over a ReadableStream; Safari (iOS) and Chromium before 124 cannot iterate streams.
  if (typeof ReadableStream !== 'undefined' && !ReadableStream.prototype[Symbol.asyncIterator]) {
    ReadableStream.prototype.values = function (options) {
      var preventCancel = !!(options && options.preventCancel);
      var reader = this.getReader();
      return {
        next: function () {
          return reader.read().then(
            function (r) {
              if (r.done) reader.releaseLock();
              return r;
            },
            function (e) {
              reader.releaseLock();
              throw e;
            },
          );
        },
        return: function (value) {
          var done = preventCancel ? Promise.resolve() : reader.cancel(value);
          return done.then(function () {
            reader.releaseLock();
            return { done: true, value: value };
          });
        },
        [Symbol.asyncIterator]: function () {
          return this;
        },
      };
    };
    ReadableStream.prototype[Symbol.asyncIterator] = ReadableStream.prototype.values;
  }

  var post = function (msg) {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  };

  // pdf.js and Tesseract report problems on the console, which a WebView keeps to itself; pass them to the app's log.
  ['warn', 'error'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      try {
        post({ type: 'log', level: level, message: Array.prototype.map.call(arguments, String).join(' ').slice(0, 800) });
      } catch (e) {}
      return original.apply(console, arguments);
    };
  });
  var originalLog = console.log;
  console.log = function (first) {
    if (typeof first === 'string' && /^Warning:/.test(first)) console.warn.apply(console, arguments);
    else originalLog.apply(console, arguments);
  };

  var jobs = {};

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function concat(parts) {
    var len = 0;
    for (var i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Uint8Array(len);
    var off = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], off);
      off += parts[j].length;
    }
    return out;
  }

  function cleanSpaces(s) {
    return s.replace(/[  -​  　]/g, ' ').replace(/[ \t\f\v]+/g, ' ').trim();
  }

  // Joins wrapped lines into paragraphs and repairs words hyphenated across line breaks.
  function linesToParagraphs(lines) {
    lines = lines.map(cleanSpaces).filter(function (l) {
      return l.length > 0 && !/^\d{1,4}$/.test(l);
    });
    if (!lines.length) return '';
    var maxLen = 0;
    lines.forEach(function (l) {
      if (l.length > maxLen) maxLen = l.length;
    });
    var paras = [];
    var cur = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!cur) {
        cur = line;
      } else if (/[A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]-$/.test(cur) && /^[a-zçğıöşü]/.test(line)) {
        cur = cur.slice(0, -1) + line;
      } else {
        cur += ' ' + line;
      }
      var endsSentence = /[.!?…:;"”»)]$/.test(line);
      var isShort = line.length < maxLen * 0.75;
      if (endsSentence && isShort) {
        paras.push(cur);
        cur = '';
      }
    }
    if (cur) paras.push(cur);
    return paras.join('\n');
  }

  // ---------- PDF ----------
  // Hands pdf.js its image decoders (bundled into the page) instead of letting it fetch them.
  function BundledData() {}
  BundledData.prototype.fetch = function (req) {
    var b64 = req.kind === 'wasmUrl' && globalThis.__pdfWasm && globalThis.__pdfWasm[req.filename];
    if (!b64) return Promise.reject(new Error('Not bundled: ' + req.filename));
    return Promise.resolve(b64ToBytes(b64));
  };

  async function extractPdf(job, bytes) {
    var lib = globalThis.pdfjsLib;
    var doc;
    var task;
    try {
      task = lib.getDocument({
        data: bytes,
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        stopAtErrors: false,
        wasmUrl: 'https://engine.local/pdfjs/',
        useWorkerFetch: false,
        BinaryDataFactory: BundledData,
      });
      doc = await task.promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') throw new Error('Şifreli PDF dosyaları henüz desteklenmiyor.');
      if (e && e.name === 'InvalidPDFException') throw new Error('PDF dosyası bozuk veya okunamıyor.');
      throw e;
    }
    var info = {};
    try {
      info = (await doc.getMetadata()).info || {};
    } catch (e) {}
    post({
      type: 'meta',
      jobId: job.id,
      title: info.Title || null,
      author: info.Author || null,
      language: info.Language || null,
      sectionCount: doc.numPages,
    });
    // Running headers/footers (book title, chapter name, "Sayfa 12") repeat on many pages and should not be read aloud.
    // Their shape is learned from the top/bottom lines of every page; the first pages are held back until it is known.
    var counts = {};
    var hasImage = {};
    var seen = 0;
    var held = [];
    var warmup = Math.min(8, doc.numPages);
    // Short lines (page numbers like "— 12 —") match with digits ignored; longer ones only when identical.
    var norm = function (t) {
      var c = cleanSpaces(t)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
      return c.length <= 40 ? c.replace(/\d+/g, '#') : c;
    };
    // Top two lines are keyed "t:", bottom two "b:". Real running heads repeat on most pages, chapter titles on few,
    // so a line only counts as boilerplate once it shows up on 30% of the pages seen so far.
    // Edge lines are picked both by vertical position and by content order, since some PDF producers
    // (and some WebView versions) report text in an order that does not follow the page layout.
    var edgeLines = function (lines) {
      var picks = {};
      var mark = function (i) {
        picks[i] = 'e:';
      };
      var byY = lines
        .map(function (l, i) {
          return { i: i, y: typeof l.y === 'number' ? l.y : 0 };
        })
        .sort(function (a, b) {
          return b.y - a.y;
        });
      byY.slice(0, 2).concat(byY.slice(-2)).forEach(function (o) {
        mark(o.i);
      });
      [0, 1, lines.length - 2, lines.length - 1].forEach(function (i) {
        if (i >= 0 && i < lines.length) mark(i);
      });
      return picks;
    };
    var emit = function (pageNo, lines) {
      var edges = edgeLines(lines);
      var threshold = Math.max(2, Math.ceil(seen * 0.3));
      var kept = lines
        .filter(function (l, i) {
          if (!edges[i]) return true;
          var k = norm(l.text);
          return !(k.length && k.length < 80 && (counts[edges[i] + k] || 0) >= threshold);
        })
        .map(function (l) {
          return l.text;
        });
      var text = linesToParagraphs(kept);
      // Only pages that actually draw an image are scans; text-less pages without one are just blank.
      var needsOcr = text.replace(/\s/g, '').length < 20 && !!hasImage[pageNo];
      emitSection(job, pageNo - 1, 'Sayfa ' + pageNo, text, needsOcr && {
        render: function () {
          return renderPdfPage(doc, pageNo);
        },
      });
    };
    for (var p = 1; p <= doc.numPages; p++) {
      if (job.cancelled) return;
      var lines = [];
      try {
        var page = await doc.getPage(p);
        var tc = await page.getTextContent();
        var line = '';
        var lineY = null;
        var lastY = null;
        tc.items.forEach(function (it) {
          if (typeof it.str !== 'string') return;
          var y = it.transform ? it.transform[5] : null;
          if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && line) {
            lines.push({ text: line, y: lineY });
            line = '';
          }
          if (!line) lineY = y;
          line += it.str;
          if (it.hasEOL) {
            lines.push({ text: line, y: lineY });
            line = '';
          }
          if (y !== null) lastY = y;
        });
        if (line) lines.push({ text: line, y: lineY });
        lines = lines.filter(function (l) {
          return cleanSpaces(l.text).length > 0;
        });
        var rawChars = lines.reduce(function (n, l) {
          return n + l.text.replace(/\s/g, '').length;
        }, 0);
        if (rawChars < 200) hasImage[p] = await pageHasImage(page);
        page.cleanup();
      } catch (e) {
        lines = [];
      }
      seen++;
      var edges = edgeLines(lines);
      var counted = {};
      lines.forEach(function (l, i) {
        var k = norm(l.text);
        if (edges[i] && k && !counted[edges[i] + k]) {
          counted[edges[i] + k] = true;
          counts[edges[i] + k] = (counts[edges[i] + k] || 0) + 1;
        }
      });
      if (p <= warmup) {
        held.push({ p: p, lines: lines });
        if (p === warmup) {
          held.forEach(function (h) {
            emit(h.p, h.lines);
          });
          held = [];
        }
      } else {
        emit(p, lines);
      }
    }
    held.forEach(function (h) {
      emit(h.p, h.lines);
    });
    try {
      await finishOcr(job);
    } finally {
      await task.destroy();
    }
  }

  async function pageHasImage(page) {
    try {
      var OPS = globalThis.pdfjsLib.OPS;
      var ops = await page.getOperatorList();
      return ops.fnArray.some(function (fn) {
        return fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintImageXObjectRepeat;
      });
    } catch (e) {
      return true;
    }
  }

  async function renderPdfPage(doc, pageNo) {
    var page = await doc.getPage(pageNo);
    var base = page.getViewport({ scale: 1 });
    var scale = Math.min(3, OCR_MAX_SIDE / Math.max(base.width, base.height, 1));
    var viewport = page.getViewport({ scale: scale });
    var canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    page.cleanup();
    return canvas;
  }

  // ---------- HTML / XHTML helpers ----------
  var BLOCK = {
    P: 1, DIV: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, LI: 1, BLOCKQUOTE: 1, BR: 1, TR: 1,
    SECTION: 1, ARTICLE: 1, PRE: 1, DD: 1, DT: 1, FIGCAPTION: 1, HR: 1, TABLE: 1, UL: 1, OL: 1,
    ASIDE: 1, HEADER: 1, FOOTER: 1, TITLE: 1, SUBTITLE: 1, POEM: 1, STANZA: 1, V: 1, 'TEXT-AUTHOR': 1, EPIGRAPH: 1,
  };
  var SKIP = { SCRIPT: 1, STYLE: 1, HEAD: 1, NOSCRIPT: 1, SVG: 1, BINARY: 1, RT: 1 };

  function nodeText(root) {
    var out = [];
    var images = 0;
    var sources = [];
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          out.push(c.nodeValue.replace(/\s+/g, ' '));
        } else if (c.nodeType === 1) {
          var tag = (c.localName || c.nodeName).toUpperCase();
          if (SKIP[tag]) continue;
          if (tag === 'IMG' || tag === 'IMAGE') {
            images++;
            var src = c.getAttribute('src') || c.getAttribute('href') || c.getAttribute('xlink:href');
            if (!src && c.getAttributeNS) src = c.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
            if (src) sources.push(src);
            continue;
          }
          var block = BLOCK[tag];
          if (block) out.push('\n');
          walk(c);
          if (block) out.push('\n');
        }
      }
    })(root);
    var text = out
      .join('')
      .split('\n')
      .map(cleanSpaces)
      .filter(Boolean)
      .join('\n');
    return { text: text, images: images, sources: sources };
  }

  // Short text of the first heading in a chapter document, used when the table of contents gives no title.
  function firstHeading(doc) {
    var h = null;
    ['h1', 'h2', 'h3'].some(function (name) {
      h = allByLocalName(doc, name)[0] || null;
      return !!h;
    });
    var t = h ? (h.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return t && t.length <= 80 ? t : null;
  }

  function parseMarkup(str, preferXml) {
    var parser = new DOMParser();
    if (preferXml) {
      var d = parser.parseFromString(str, 'application/xhtml+xml');
      if (!d.getElementsByTagName('parsererror').length) return d;
    }
    return parser.parseFromString(str, 'text/html');
  }

  function firstByLocalName(doc, name) {
    var all = doc.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) if (all[i].localName === name) return all[i];
    return null;
  }

  function allByLocalName(root, name) {
    var res = [];
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) if (all[i].localName === name) res.push(all[i]);
    return res;
  }

  function resolvePath(baseFile, href) {
    var base = 'http://x/' + baseFile;
    var u = new URL(href, base);
    return decodeURIComponent(u.pathname.slice(1));
  }

  // ---------- EPUB ----------
  async function extractEpub(job, bytes) {
    var zip = await JSZip.loadAsync(bytes);
    if (zip.file('META-INF/encryption.xml')) {
      var enc = await zip.file('META-INF/encryption.xml').async('string');
      if (/EncryptedData/.test(enc) && !/obfuscation/i.test(enc)) {
        throw new Error('Bu EPUB DRM ile korunuyor ve okunamıyor.');
      }
    }
    var containerFile = zip.file('META-INF/container.xml');
    if (!containerFile) throw new Error('Geçersiz EPUB: container.xml bulunamadı.');
    var container = parseMarkup(await containerFile.async('string'), true);
    var rootfile = firstByLocalName(container, 'rootfile');
    var opfPath = rootfile && rootfile.getAttribute('full-path');
    if (!opfPath || !zip.file(opfPath)) throw new Error('Geçersiz EPUB: içerik dosyası bulunamadı.');
    var opf = parseMarkup(await zip.file(opfPath).async('string'), true);

    var getMeta = function (name) {
      var el = firstByLocalName(opf, name);
      return el ? cleanSpaces(el.textContent || '') : null;
    };

    var manifest = {};
    var navHref = null;
    allByLocalName(opf, 'item').forEach(function (it) {
      var href = resolvePath(opfPath, it.getAttribute('href') || '');
      manifest[it.getAttribute('id')] = { href: href, type: it.getAttribute('media-type') || '' };
      if ((it.getAttribute('properties') || '').split(/\s+/).indexOf('nav') >= 0) navHref = href;
    });
    var spineEl = firstByLocalName(opf, 'spine');
    var ncxId = spineEl && spineEl.getAttribute('toc');
    var spine = allByLocalName(opf, 'itemref')
      .map(function (r) {
        return manifest[r.getAttribute('idref')];
      })
      .filter(function (m) {
        return m && /html|xml/.test(m.type);
      });

    var titles = {};
    try {
      if (navHref && zip.file(navHref)) {
        var nav = parseMarkup(await zip.file(navHref).async('string'), true);
        allByLocalName(nav, 'a').forEach(function (a) {
          var h = a.getAttribute('href');
          if (!h) return;
          var p = resolvePath(navHref, h.split('#')[0]);
          if (!titles[p]) titles[p] = cleanSpaces(a.textContent || '');
        });
      } else if (ncxId && manifest[ncxId] && zip.file(manifest[ncxId].href)) {
        var ncxPath = manifest[ncxId].href;
        var ncx = parseMarkup(await zip.file(ncxPath).async('string'), true);
        allByLocalName(ncx, 'navPoint').forEach(function (np) {
          var content = firstByLocalName(np, 'content');
          var label = firstByLocalName(np, 'text');
          if (!content || !label) return;
          var p = resolvePath(ncxPath, (content.getAttribute('src') || '').split('#')[0]);
          if (!titles[p]) titles[p] = cleanSpaces(label.textContent || '');
        });
      }
    } catch (e) {}

    post({
      type: 'meta',
      jobId: job.id,
      title: getMeta('title'),
      author: getMeta('creator'),
      language: getMeta('language'),
      sectionCount: spine.length,
    });

    var lastTitle = null;
    for (var i = 0; i < spine.length; i++) {
      if (job.cancelled) return;
      var item = spine[i];
      var f = zip.file(item.href);
      var res = { text: '', images: 0 };
      var heading = null;
      if (f) {
        var d = parseMarkup(await f.async('string'), true);
        res = nodeText(d.body || d.documentElement);
        heading = firstHeading(d);
      }
      if (titles[item.href]) lastTitle = titles[item.href];
      var sectionTitle = titles[item.href] || heading || lastTitle || 'Bölüm ' + (i + 1);
      var files = [];
      if (res.images > 0 && res.text.replace(/\s/g, '').length < 20) {
        files = (res.sources || [])
          .map(function (src) {
            return zip.file(resolvePath(item.href, src.split('#')[0]));
          })
          .filter(Boolean);
      }
      emitSection(job, i, sectionTitle, res.text, files.length > 0 && {
        images: files.map(function (zf) {
          return function () {
            return zf.async('uint8array');
          };
        }),
      });
    }
    await finishOcr(job);
  }

  // ---------- Text decoding ----------
  function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      return new TextDecoder('windows-1254').decode(bytes);
    }
  }

  function chunkParagraphs(paras, maxChars) {
    var sections = [];
    var cur = [];
    var len = 0;
    paras.forEach(function (p) {
      if (len + p.length > maxChars && cur.length) {
        sections.push(cur.join('\n'));
        cur = [];
        len = 0;
      }
      cur.push(p);
      len += p.length;
    });
    if (cur.length) sections.push(cur.join('\n'));
    return sections;
  }

  function emitChunks(job, meta, paras) {
    var sections = chunkParagraphs(paras, 6000);
    post({ type: 'meta', jobId: job.id, title: meta.title, author: meta.author, language: meta.language, sectionCount: sections.length });
    sections.forEach(function (text, i) {
      post({ type: 'section', jobId: job.id, index: i, title: 'Bölüm ' + (i + 1), text: text, needsOcr: false });
    });
  }

  function extractTxt(job, bytes) {
    var text = decodeText(bytes).replace(/\r\n?/g, '\n');
    var paras;
    if (/\n[ \t]*\n/.test(text)) {
      paras = text.split(/\n[ \t]*\n+/).map(function (p) {
        return linesToParagraphs(p.split('\n')).replace(/\n/g, ' ');
      });
    } else {
      paras = text.split('\n').map(cleanSpaces);
    }
    emitChunks(job, {}, paras.filter(Boolean));
  }

  function extractHtml(job, bytes) {
    var d = parseMarkup(decodeText(bytes), false);
    var res = nodeText(d.body || d.documentElement);
    var titleEl = d.querySelector('title');
    emitChunks(
      job,
      { title: titleEl ? cleanSpaces(titleEl.textContent) : null, language: d.documentElement.getAttribute('lang') },
      res.text.split('\n'),
    );
  }

  // ---------- FB2 ----------
  function extractFb2(job, bytes) {
    var d = new DOMParser().parseFromString(decodeText(bytes), 'application/xml');
    var titleInfo = firstByLocalName(d, 'title-info');
    var pick = function (root, name) {
      var el = root ? allByLocalName(root, name)[0] : null;
      return el ? cleanSpaces(el.textContent || '') : null;
    };
    var author = null;
    if (titleInfo) {
      var a = allByLocalName(titleInfo, 'author')[0];
      if (a) author = [pick(a, 'first-name'), pick(a, 'middle-name'), pick(a, 'last-name')].filter(Boolean).join(' ') || null;
    }
    var bodies = allByLocalName(d, 'body').filter(function (b) {
      return b.getAttribute('name') !== 'notes';
    });
    var sections = [];
    bodies.forEach(function (b) {
      var top = [];
      for (var c = b.firstElementChild; c; c = c.nextElementSibling) if (c.localName === 'section') top.push(c);
      if (!top.length) top = [b];
      top.forEach(function (s) {
        var t = null;
        for (var c = s.firstElementChild; c; c = c.nextElementSibling) {
          if (c.localName === 'title') {
            t = cleanSpaces(c.textContent || '');
            break;
          }
        }
        sections.push({ title: t, text: nodeText(s).text });
      });
    });
    post({
      type: 'meta',
      jobId: job.id,
      title: pick(titleInfo, 'book-title'),
      author: author,
      language: pick(titleInfo, 'lang'),
      sectionCount: sections.length,
    });
    sections.forEach(function (s, i) {
      post({ type: 'section', jobId: job.id, index: i, title: s.title || 'Bölüm ' + (i + 1), text: s.text, needsOcr: false });
    });
  }

  // ---------- OCR ----------
  var OCR_MAX_SIDE = 2000;
  var ocr = { assets: {}, worker: null, starting: null };

  function blobUrl(data) {
    return URL.createObjectURL(new Blob([data], { type: 'application/javascript' }));
  }

  // Everything is served from blob URLs: the boot script maps the fake language URLs onto them, so nothing is downloaded.
  function getOcrWorker() {
    if (ocr.worker) return Promise.resolve(ocr.worker);
    if (ocr.starting) return ocr.starting;
    ocr.starting = (async function () {
      var a = ocr.assets;
      if (!a.core || !a.worker || !a.tur || !a.eng) throw new Error('OCR verileri yüklenmedi.');
      var map = {
        'https://ocr.local/tur.traineddata.gz': URL.createObjectURL(new Blob([a.tur])),
        'https://ocr.local/eng.traineddata.gz': URL.createObjectURL(new Blob([a.eng])),
      };
      var boot =
        'var __map=' + JSON.stringify(map) + ';var __fetch=self.fetch.bind(self);' +
        'self.fetch=function(u,o){return __fetch(__map[u]||u,o);};' +
        'importScripts(' + JSON.stringify(blobUrl(a.core)) + ');importScripts(' + JSON.stringify(blobUrl(a.worker)) + ');';
      var worker = await Tesseract.createWorker(['tur', 'eng'], 1, {
        workerPath: blobUrl(boot),
        workerBlobURL: false,
        langPath: 'https://ocr.local',
        gzip: true,
        cacheMethod: 'none',
      });
      ocr.worker = worker;
      return worker;
    })();
    ocr.starting.catch(function () {
      ocr.starting = null;
    });
    return ocr.starting;
  }

  function ocrText(raw) {
    return raw
      .replace(/\r/g, '')
      .split(/\n[ \t]*\n/)
      .map(function (block) {
        return linesToParagraphs(block.split('\n')).replace(/\n/g, ' ');
      })
      .filter(function (p) {
        return p.replace(/[^\p{L}\p{N}]/gu, '').length > 1;
      })
      // OCR often breaks a paragraph where a line happens to be short; rejoin mid-sentence splits.
      .reduce(function (acc, p) {
        var prev = acc[acc.length - 1];
        var lower = /^[a-zçğıöşüâîû]/.test(p);
        // A word hyphenated at the end of a line ("işve-" + "reniyim") is joined back together.
        if (prev && lower && /[A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]-$/.test(prev)) acc[acc.length - 1] = prev.slice(0, -1) + p;
        else if (prev && lower && !/[.!?…:;"”»)]$/.test(prev)) acc[acc.length - 1] = prev + ' ' + p;
        else acc.push(p);
        return acc;
      }, [])
      .join('\n');
  }

  async function imageToCanvas(bytes) {
    var bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'from-image' });
    var scale = Math.min(1, OCR_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    return canvas;
  }

  // Size and share of dark pixels of a page image, to tell a blank render from text that was not recognised.
  function describeCanvas(canvas) {
    try {
      var w = 100;
      var h = Math.max(1, Math.round((canvas.height / Math.max(1, canvas.width)) * w));
      var small = document.createElement('canvas');
      small.width = w;
      small.height = h;
      var ctx = small.getContext('2d');
      ctx.drawImage(canvas, 0, 0, w, h);
      var px = ctx.getImageData(0, 0, w, h).data;
      var dark = 0;
      for (var i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 384) dark++;
      return canvas.width + 'x' + canvas.height + ', ' + Math.round((dark / (w * h)) * 1000) / 10 + '% dark';
    } catch (e) {
      return 'unreadable canvas';
    }
  }

  async function recognize(worker, canvas) {
    try {
      var res = await worker.recognize(canvas);
      var text = ocrText(res.data.text || '');
      if (!text) console.warn('OCR found no text: ' + describeCanvas(canvas) + ', raw ' + (res.data.text || '').length + ' chars');
      return text;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  // Posts a section unless the app already has its final text (a resumed job), and queues it for OCR when `ocrItem` is given.
  function emitSection(job, index, title, text, ocrItem) {
    if (job.skip[index]) return;
    post({ type: 'section', jobId: job.id, index: index, title: title, text: text, needsOcr: !!ocrItem });
    if (!ocrItem) return;
    ocrItem.index = index;
    ocrItem.title = title;
    job.ocr.push(ocrItem);
    job.ocrTotal++;
    if (!job.ocrLoop) {
      job.ocrLoop = ocrLoop(job);
      // Surfaced by finishOcr; keeps the rejection from being reported as unhandled meanwhile.
      job.ocrLoop.catch(function () {});
    } else if (job.ocrWake) {
      job.ocrWake();
    }
  }

  // Pages from the one being read onwards come first, so listening can start while the rest of the book is recognised.
  function nextOcrItem(job) {
    var best = -1;
    for (var i = 0; i < job.ocr.length; i++) {
      if (best < 0) {
        best = i;
        continue;
      }
      var idx = job.ocr[i].index;
      var cur = job.ocr[best].index;
      var ahead = idx >= job.focus;
      var curAhead = cur >= job.focus;
      if ((ahead && !curAhead) || (ahead === curAhead && idx < cur)) best = i;
    }
    return best < 0 ? null : job.ocr.splice(best, 1)[0];
  }

  // Runs alongside extraction. Asks the app first (it may still have to deliver the OCR data);
  // the app answers with engine.ocrStart(jobId, ok).
  async function ocrLoop(job) {
    post({ type: 'ocrNeeded', jobId: job.id, count: job.ocrTotal });
    var ok = await new Promise(function (resolve) {
      job.ocrGate = resolve;
    });
    job.ocrGate = null;
    if (!ok) return;
    var worker = await getOcrWorker();
    var done = 0;
    for (;;) {
      if (job.cancelled) return;
      var item = nextOcrItem(job);
      if (!item) {
        if (job.extracted) return;
        await new Promise(function (resolve) {
          job.ocrWake = resolve;
        });
        job.ocrWake = null;
        continue;
      }
      var texts = [];
      try {
        if (item.render) {
          texts.push(await recognize(worker, await withTimeout(item.render(), PAGE_RENDER_MS, item.title)));
        } else {
          for (var k = 0; k < item.images.length; k++) {
            texts.push(await recognize(worker, await imageToCanvas(await item.images[k]())));
          }
        }
      } catch (e) {
        console.warn('OCR failed on ' + item.title + ': ' + ((e && e.message) || e));
        texts = [];
      }
      var text = texts.filter(Boolean).join('\n');
      if (!text) console.warn('No text recognised on ' + item.title);
      post({ type: 'section', jobId: job.id, index: item.index, title: item.title, text: text, needsOcr: !text, ocr: true });
      done++;
      post({ type: 'ocrProgress', jobId: job.id, done: done, total: job.ocrTotal });
    }
  }

  // A page whose image cannot be decoded must not hold up the rest of the book.
  var PAGE_RENDER_MS = 60000;
  function withTimeout(promise, ms, what) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error(what + ' took longer than ' + ms / 1000 + ' s'));
      }, ms);
      promise.then(
        function (v) {
          clearTimeout(timer);
          resolve(v);
        },
        function (e) {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  async function finishOcr(job) {
    job.extracted = true;
    if (job.ocrWake) job.ocrWake();
    if (job.ocrLoop) await job.ocrLoop;
  }

  async function extractImages(job, bytes) {
    var bounds = job.marks.concat([bytes.length]);
    var images = [];
    for (var i = 0; i < bounds.length - 1; i++) {
      if (bounds[i + 1] > bounds[i]) images.push(bytes.subarray(bounds[i], bounds[i + 1]));
    }
    post({ type: 'meta', jobId: job.id, title: null, author: null, language: null, sectionCount: images.length });
    images.forEach(function (img, n) {
      emitSection(job, n, 'Sayfa ' + (n + 1), '', {
        images: [
          function () {
            return Promise.resolve(img);
          },
        ],
      });
    });
    await finishOcr(job);
  }

  // ---------- Sections from block elements (DOCX) ----------
  // Starts a new section at every top-level heading, and splits very long stretches so pages stay light.
  function sectionsByHeadings(root, fallbackTitle) {
    var sections = [];
    var cur = { title: null, parts: [], size: 0 };
    var flush = function () {
      if (cur.parts.length) sections.push({ title: cur.title, text: cur.parts.join('\n') });
      cur = { title: null, parts: [], size: 0 };
    };
    for (var el = root.firstElementChild; el; el = el.nextElementSibling) {
      var tag = el.tagName.toUpperCase();
      var text = nodeText(el).text;
      if (!text) continue;
      if (tag === 'H1' || tag === 'H2') {
        flush();
        cur.title = cleanSpaces(text).slice(0, 80);
      } else if (cur.size > 6000) {
        var title = cur.title;
        flush();
        cur.title = title;
      }
      cur.parts.push(text);
      cur.size += text.length;
    }
    flush();
    return sections.map(function (sec, i) {
      return { title: sec.title || fallbackTitle + ' ' + (i + 1), text: sec.text };
    });
  }

  // ---------- DOCX ----------
  async function extractDocx(job, bytes) {
    var res = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    var doc = parseMarkup('<body>' + res.value + '</body>', false);
    var sections = sectionsByHeadings(doc.body, 'Bölüm');
    var core = null;
    try {
      var zip = await JSZip.loadAsync(bytes);
      if (zip.file('docProps/core.xml')) core = parseMarkup(await zip.file('docProps/core.xml').async('string'), true);
    } catch (e) {}
    var meta = function (name) {
      var el = core && firstByLocalName(core, name);
      return el ? cleanSpaces(el.textContent || '') || null : null;
    };
    post({ type: 'meta', jobId: job.id, title: meta('title'), author: meta('creator'), language: meta('language'), sectionCount: sections.length });
    sections.forEach(function (sec, i) {
      post({ type: 'section', jobId: job.id, index: i, title: sec.title, text: sec.text, needsOcr: false });
    });
  }

  // ---------- MOBI / AZW3 (Kindle) ----------
  async function extractMobi(job, bytes) {
    var reader = new FoliateMOBI({
      unzlib: function () {
        return Promise.resolve(new Uint8Array(0));
      },
    });
    var book;
    try {
      book = await reader.open(new Blob([bytes]));
    } catch (e) {
      var msg = String((e && e.message) || e);
      if (/encrypt|drm/i.test(msg)) throw new Error('Bu Kindle kitabı DRM ile korunuyor ve okunamıyor.');
      throw new Error('Kindle (MOBI/AZW3) dosyası okunamadı.');
    }
    var meta = book.metadata || {};
    var author = Array.isArray(meta.author) ? meta.author.join(', ') : meta.author;
    var titles = {};
    (function walk(items) {
      (items || []).forEach(function (item) {
        try {
          var resolved = book.resolveHref(item.href);
          if (resolved && titles[resolved.index] == null && item.label) titles[resolved.index] = cleanSpaces(item.label);
        } catch (e) {}
        walk(item.subitems);
      });
    })(book.toc);
    var sections = book.sections.filter(function (sec) {
      return sec.linear !== 'no';
    });
    post({
      type: 'meta',
      jobId: job.id,
      title: typeof meta.title === 'string' ? meta.title : null,
      author: author || null,
      language: Array.isArray(meta.language) ? meta.language[0] : meta.language || null,
      sectionCount: sections.length,
    });
    var lastTitle = null;
    for (var i = 0; i < sections.length; i++) {
      if (job.cancelled) return;
      var text = '';
      var heading = null;
      try {
        var doc = await sections[i].createDocument();
        text = nodeText(doc.body || doc.documentElement).text;
        heading = firstHeading(doc);
      } catch (e) {}
      var idx = book.sections.indexOf(sections[i]);
      if (titles[idx]) lastTitle = titles[idx];
      post({ type: 'section', jobId: job.id, index: i, title: titles[idx] || heading || lastTitle || 'Bölüm ' + (i + 1), text: text, needsOcr: false });
    }
  }

  var EXTRACTORS = {
    pdf: extractPdf,
    epub: extractEpub,
    txt: extractTxt,
    html: extractHtml,
    fb2: extractFb2,
    images: extractImages,
    docx: extractDocx,
    mobi: extractMobi,
  };

  window.engine = {
    // options.skip: section indexes the app already holds final text for (when resuming); options.focus: page being read.
    begin: function (jobId, kind, options) {
      var skip = {};
      ((options && options.skip) || []).forEach(function (i) {
        skip[i] = true;
      });
      jobs[jobId] = {
        id: jobId, kind: kind, parts: [], marks: [], size: 0, skip: skip, focus: (options && options.focus) || 0,
        ocr: [], ocrTotal: 0, ocrLoop: null, ocrGate: null, ocrWake: null, extracted: false, cancelled: false,
      };
    },
    focus: function (jobId, index) {
      var job = jobs[jobId];
      if (job) job.focus = index;
    },
    // Separates the files of a multi-file job (photo books) inside the byte stream.
    mark: function (jobId) {
      var job = jobs[jobId];
      if (job) job.marks.push(job.size);
    },
    ocrStart: function (jobId, ok) {
      var job = jobs[jobId];
      if (job && job.ocrGate) job.ocrGate(!!ok);
    },
    hasOcr: function () {
      post({ type: 'ocrAssets', ready: !!(ocr.assets.core && ocr.assets.worker && ocr.assets.tur && ocr.assets.eng) });
    },
    chunk: function (jobId, b64) {
      var job = jobs[jobId];
      if (job) {
        var part = b64ToBytes(b64);
        job.parts.push(part);
        job.size += part.length;
      }
      post({ type: 'ack', jobId: jobId });
    },
    cancel: function (jobId) {
      var job = jobs[jobId];
      if (!job) return;
      job.cancelled = true;
      if (job.ocrGate) job.ocrGate(false);
      if (job.ocrWake) job.ocrWake();
    },
    end: async function (jobId) {
      var job = jobs[jobId];
      if (!job) return;
      var bytes = concat(job.parts);
      job.parts = null;
      if (job.kind.indexOf('asset:') === 0) {
        ocr.assets[job.kind.slice(6)] = bytes;
        delete jobs[jobId];
        post({ type: 'done', jobId: jobId });
        return;
      }
      try {
        var fn = EXTRACTORS[job.kind];
        if (!fn) throw new Error('Desteklenmeyen format: ' + job.kind);
        await fn(job, bytes);
        post({ type: job.cancelled ? 'cancelled' : 'done', jobId: jobId });
      } catch (e) {
        post({ type: 'error', jobId: jobId, message: (e && e.message) || String(e) });
      } finally {
        delete jobs[jobId];
      }
    },
  };

  post({ type: 'ready' });
})();
