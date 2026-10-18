// Runs inside the hidden extractor WebView. Receives a book file in base64 chunks and posts its text back section by section.
(function () {
  'use strict';

  var post = function (msg) {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
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
    var seen = 0;
    var held = [];
    var warmup = Math.min(8, doc.numPages);
    // Short lines (page numbers like "— 12 —") match with digits ignored; longer ones only when identical.
    var norm = function (t) {
      var c = cleanSpaces(t).toLowerCase();
      return c.length <= 40 ? c.replace(/\d+/g, '#') : c;
    };
    // Top two lines are keyed "t:", bottom two "b:". Real running heads repeat on most pages, chapter titles on few,
    // so a line only counts as boilerplate once it shows up on 30% of the pages seen so far.
    var edgeLines = function (lines) {
      var order = lines
        .map(function (l, i) {
          return { i: i, y: l.y };
        })
        .sort(function (a, b) {
          return b.y - a.y;
        });
      var picks = {};
      order.slice(0, 2).forEach(function (o) {
        picks[o.i] = 't:';
      });
      order.slice(-2).forEach(function (o) {
        picks[o.i] = 'b:';
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
      post({
        type: 'section',
        jobId: job.id,
        index: pageNo - 1,
        title: 'Sayfa ' + pageNo,
        text: text,
        needsOcr: text.replace(/\s/g, '').length < 20,
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
    await task.destroy();
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
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          out.push(c.nodeValue.replace(/\s+/g, ' '));
        } else if (c.nodeType === 1) {
          var tag = (c.localName || c.nodeName).toUpperCase();
          if (SKIP[tag]) continue;
          if (tag === 'IMG' || tag === 'IMAGE') {
            images++;
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
    return { text: text, images: images };
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
      if (f) {
        var d = parseMarkup(await f.async('string'), true);
        res = nodeText(d.body || d.documentElement);
      }
      if (titles[item.href]) lastTitle = titles[item.href];
      post({
        type: 'section',
        jobId: job.id,
        index: i,
        title: titles[item.href] || lastTitle || 'Bölüm ' + (i + 1),
        text: res.text,
        needsOcr: res.images > 0 && res.text.replace(/\s/g, '').length < 20,
      });
    }
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

  var EXTRACTORS = { pdf: extractPdf, epub: extractEpub, txt: extractTxt, html: extractHtml, fb2: extractFb2 };

  window.engine = {
    begin: function (jobId, kind) {
      jobs[jobId] = { id: jobId, kind: kind, parts: [], cancelled: false };
    },
    chunk: function (jobId, b64) {
      var job = jobs[jobId];
      if (job) job.parts.push(b64ToBytes(b64));
      post({ type: 'ack', jobId: jobId });
    },
    cancel: function (jobId) {
      if (jobs[jobId]) jobs[jobId].cancelled = true;
    },
    end: async function (jobId) {
      var job = jobs[jobId];
      if (!job) return;
      var bytes = concat(job.parts);
      job.parts = null;
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
