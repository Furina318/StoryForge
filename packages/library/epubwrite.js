'use strict';
/**
 * 极简 EPUB 3 打包器（store 方式，不引依赖）。
 *
 * 为什么 store：EPUB 规范只要求 mimetype 是第一个条目且不压缩；其余条目可以是
 * stored（method 0）。省掉 deflate 就不用给浏览器/主进程各带一个压缩实现。
 *
 * 用法：
 *   SFEpub.build({ title, author, chapters:[{title, paragraphs:[string] }], css? }) -> Uint8Array
 *   UFEpub.build(...) -> Buffer（node）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SFEpub = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(str) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'utf8'));
    return new TextEncoder().encode(str);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---- 只写 store 的 zip ---- */
  function zip(entries) {
    /* entries: [{ name, data:Uint8Array, date? }] 顺序即写入顺序 */
    var chunks = [];
    var central = [];
    var offset = 0;
    var now = new Date();
    var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() / 2 | 0)) & 0xFFFF;
    var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    entries.forEach(function (e) {
      var nameBytes = utf8(e.name);
      var data = e.data || new Uint8Array(0);
      var crc = crc32(data);

      var local = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);          /* version needed */
      dv.setUint16(6, 0, true);           /* flags */
      dv.setUint16(8, 0, true);           /* method = store */
      dv.setUint16(10, dosTime, true);
      dv.setUint16(12, dosDate, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      chunks.push(local, data);

      var cen = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);

      offset += local.length + data.length;
    });

    var cenSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cenSize, true);
    ev.setUint32(16, offset, true);

    var total = offset + cenSize + end.length;
    var out = new Uint8Array(total);
    var pos = 0;
    chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
    central.forEach(function (c) { out.set(c, pos); pos += c.length; });
    out.set(end, pos);
    return out;
  }

  function chapterXhtml(title, paragraphs) {
    var body = (paragraphs || []).map(function (p) {
      return '<p>' + esc(p) + '</p>';
    }).join('\n');
    return '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">\n' +
      '<head><meta charset="utf-8"/><title>' + esc(title) + '</title>\n' +
      '<link rel="stylesheet" type="text/css" href="style.css"/></head>\n' +
      '<body><h2>' + esc(title) + '</h2>\n' + body + '\n</body></html>\n';
  }

  function esc2(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* 一章的 xhtml：para → <p>，img → <figure>（图注走 figcaption） */
  function chapterXhtmlBlocks(title, blocks) {
    var body = (blocks || []).map(function (b) {
      if (!b) return '';
      if (b.kind === 'img' && b.name) {
        return '<figure><img src="../images/' + esc2(b.name) + '" alt=""/>' +
          (b.caption ? '<figcaption>' + esc2(b.caption) + '</figcaption>' : '') + '</figure>';
      }
      var t = String(b.text == null ? '' : b.text).trim();
      return t ? '<p>' + esc2(t) + '</p>' : '';
    }).filter(Boolean).join('\n');
    return '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">\n' +
      '<head><meta charset="utf-8"/><title>' + esc2(title) + '</title>' +
      '<link rel="stylesheet" type="text/css" href="../style.css"/></head>\n' +
      '<body><h2>' + esc2(title) + '</h2>\n' + body + '\n</body></html>\n';
  }

  function build(opts) {
    var o = opts || {};
    var title = o.title || '未命名';
    var author = o.author || '';
    var chapters = Array.isArray(o.chapters) ? o.chapters : [];
    var uid = 'urn:uuid:storyforge-' + Date.now().toString(36);

    var items = [];
    var spine = [];
    var navLis = [];
    var imgs = [];
    var seenImg = {};
    chapters.forEach(function (ch) {
      (ch.blocks || []).forEach(function (b) {
        if (b && b.kind === 'img' && b.name && b.bytes && !seenImg[b.name]) {
          seenImg[b.name] = 1;
          imgs.push({ name: b.name, bytes: b.bytes, mime: b.mime || 'image/jpeg' });
        }
      });
    });
    imgs.forEach(function (im, k) {
      items.push('<item id="img' + (k + 1) + '" href="images/' + im.name + '" media-type="' + im.mime + '"/>');
    });
    chapters.forEach(function (ch, i) {
      var id = 'ch' + (i + 1);
      var file = 'text/' + id + '.xhtml';
      items.push('<item id="' + id + '" href="' + file + '" media-type="application/xhtml+xml"/>');
      spine.push('<itemref idref="' + id + '"/>');
      navLis.push('<li><a href="' + file + '">' + esc(ch.title || ('第 ' + (i + 1) + ' 章')) + '</a></li>');
    });

    var opf = '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      '<dc:identifier id="bookid">' + uid + '</dc:identifier>\n' +
      '<dc:title>' + esc(title) + '</dc:title>\n' +
      (author ? '<dc:creator>' + esc(author) + '</dc:creator>\n' : '') +
      '<dc:language>zh-CN</dc:language>\n' +
      '<meta property="dcterms:modified">' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</meta>\n' +
      '</metadata>\n<manifest>\n' +
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' +
      '<item id="css" href="style.css" media-type="text/css"/>\n' +
      items.join('\n') + '\n</manifest>\n' +
      '<spine>\n' + spine.join('\n') + '\n</spine>\n</package>\n';

    var nav = '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">\n' +
      '<head><meta charset="utf-8"/><title>目录</title></head>\n' +
      '<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>\n' +
      navLis.join('\n') + '\n</ol></nav></body></html>\n';

    var container = '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n' +
      '</container>\n';

    var css = o.css || 'body{font-family:serif;line-height:1.8;margin:0 6%}\nh2{font-size:1.2em;margin:1.2em 0 .8em}\np{margin:0 0 .9em;text-indent:2em}\n';

    var entries = [];
    entries.push({ name: 'mimetype', data: utf8('application/epub+zip') });
    entries.push({ name: 'META-INF/container.xml', data: utf8(container) });
    entries.push({ name: 'OEBPS/content.opf', data: utf8(opf) });
    entries.push({ name: 'OEBPS/nav.xhtml', data: utf8(nav) });
    entries.push({ name: 'OEBPS/style.css', data: utf8(css) });
    chapters.forEach(function (ch, i) {
      var _ch = chapters[i];
      var _body = Array.isArray(_ch.blocks)
        ? chapterXhtmlBlocks(_ch.title || ('第 ' + (i + 1) + ' 章'), _ch.blocks)
        : chapterXhtml(_ch.title || ('第 ' + (i + 1) + ' 章'), _ch.paragraphs || []);
      entries.push({ name: 'OEBPS/text/ch' + (i + 1) + '.xhtml', data: utf8(_body) });
    });

    imgs.forEach(function (im) {
      entries.push({ name: 'OEBPS/images/' + im.name, data: im.bytes });
    });
    return zip(entries);
  }

  return { build: build, zip: zip, crc32: crc32, chapterXhtml: chapterXhtml };
});
