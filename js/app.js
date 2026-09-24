/* واجهة المنصة: تحميل المحرك، تشغيل الفحص، عرض النتائج على الخريطة، وتصدير التقارير. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var QA = window.QAEngine, Reader = window.GdalReader;

  // أحجام ملفات المحرك (لعرض نسبة التحميل)
  var ENGINE_FILES = [['gdal/gdal3WebAssembly.wasm', 28219835], ['gdal/gdal3WebAssembly.data', 11595145]];

  var Gdal = null, enginePromise = null;
  var network = 'water', chosen = null;
  var state = null;            // نتيجة آخر فحص
  var map, selType = null;

  // ------------------------------------------------------------ عناصر مساعدة
  function el(tag, props) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) { e[k] = props[k]; });
    for (var i = 2; i < arguments.length; i++) e.append(arguments[i]);
    return e;
  }
  function showErr(msg) { var e = $('err'); e.textContent = msg; e.hidden = false; }
  function hideErr() { $('err').hidden = true; }
  function setProgress(p, msg) {
    $('bar').style.width = Math.max(2, Math.min(100, p * 100)) + '%';
    if (msg) $('status').textContent = msg;
  }
  function setEngine(kind, text) {
    var c = $('engine'); c.className = 'chip' + (kind === 'ready' ? ' ready' : kind === 'failed' ? ' failed' : '');
    $('engine-text').textContent = text;
  }

  // ------------------------------------------------------------ تحميل المحرك
  async function preload(onPct) {
    var total = ENGINE_FILES.reduce(function (s, f) { return s + f[1]; }, 0), loaded = 0;
    for (var i = 0; i < ENGINE_FILES.length; i++) {
      var r = await fetch(ENGINE_FILES[i][0], { cache: 'force-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + ENGINE_FILES[i][0]);
      if (r.body && r.body.getReader) {
        var rd = r.body.getReader();
        for (;;) {
          var chunk = await rd.read();
          if (chunk.done) break;
          loaded += chunk.value.length;
          onPct(Math.min(99, loaded / total * 100));
        }
      } else {
        loaded += (await r.arrayBuffer()).byteLength; onPct(Math.min(99, loaded / total * 100));
      }
    }
  }

  function loadEngine() {
    if (enginePromise) return enginePromise;
    enginePromise = (async function () {
      if (typeof WebAssembly !== 'object' || typeof Worker === 'undefined') {
        throw new Error('المتصفح ده قديم. استخدم Chrome أو Edge أو Firefox حديث.');
      }
      setEngine('loading', 'جاري تحميل المحرك (أول مرة فقط) 0%');
      await preload(function (p) { setEngine('loading', 'جاري تحميل المحرك (أول مرة فقط) ' + Math.round(p) + '%'); });
      setEngine('loading', 'جاري تشغيل المحرك...');
      // مسار مطلق: المسار النسبي بيتفسّر غلط جوه الـ worker لو الموقع منشور في مسار فرعي
      var base = new URL('gdal', document.baseURI).href;
      var timeout = new Promise(function (_, rej) {
        setTimeout(function () { rej(new Error('المحرك اتأخر في التشغيل. حدّث الصفحة، ولو المشكلة استمرت جرّب Chrome أو Edge.')); }, 90000);
      });
      Gdal = await Promise.race([window.initGdalJs({ path: base, useWorker: true }), timeout]);
      setEngine('ready', 'المحرك جاهز');
      return Gdal;
    })();
    enginePromise.catch(function (e) {
      console.error(e);
      setEngine('failed', 'تعذر تحميل المحرك');
      showErr((e && e.message) || 'تعذر تحميل محرك GDAL. تأكد من الاتصال بالإنترنت وحدّث الصفحة.');
      enginePromise = null;
    });
    return enginePromise;
  }

  // ------------------------------------------------------------ الخريطة
  var NET_COLOR = { water: '#1d6fa5', wastewater: '#7a5a2b' };
  var POINT_COLORS = ['#0b7285', '#e8590c', '#5f3dc4', '#2b8a3e', '#c2255c', '#495057'];
  var BIG_LAYER = 50000;      // طبقة أكبر من كده مبتتعرضش تلقائيًا (لتخفيف الحمل)
  var layersControl, overlays = [], errOverlay = null;

  function initMap() {
    map = L.map('map', { preferCanvas: true, worldCopyJump: true }).setView([24.7, 46.7], 5);
    var osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' });
    var sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Tiles &copy; Esri' });
    osm.addTo(map);
    layersControl = L.control.layers({ 'خريطة': osm, 'صور أقمار صناعية': sat }, null, { position: 'topright' }).addTo(map);
  }

  function addOverlay(layer, name, visible) {
    overlays.push({ layer: layer, name: name });
    layersControl.addOverlay(layer, name);
    if (visible) layer.addTo(map);
  }
  function removeOverlay(layer) {
    map.removeLayer(layer);
    layersControl.removeLayer(layer);
    overlays = overlays.filter(function (o) { return o.layer !== layer; });
  }
  function clearOverlays() {
    overlays.slice().forEach(function (o) { removeOverlay(o.layer); });
    errOverlay = null;
  }

  // طبقة بتتبني أول مرة تتفعّل بس (عشان الطبقات الكبيرة متأخرش التشغيل)
  function lazyGroup(build) {
    var g = L.layerGroup(), built = false;
    g.on('add', function () { if (!built) { built = true; build(g); } });
    return g;
  }

  function dataPopup(fc, props) {
    var box = el('div');
    box.append(el('b', { textContent: fc + ' — OID ' + props.__OID__ }));
    var t = el('table', { className: 'attrs' });
    Object.keys(props).forEach(function (k) {
      if (k === '__OID__') return;
      var v = props[k];
      t.append(el('tr', null, el('td', { textContent: k }), el('td', { textContent: v === null || v === undefined ? '—' : v })));
    });
    box.append(t);
    return box;
  }

  function geomBounds(features) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    var walk = function (c) {
      if (typeof c[0] === 'number') {
        if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1];
        if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1];
      } else c.forEach(walk);
    };
    features.forEach(function (f) { if (f.geometry && f.geometry.coordinates) walk(f.geometry.coordinates); });
    return b[0] === Infinity ? null : L.latLngBounds([[b[1], b[0]], [b[3], b[2]]]);
  }

  // كل طبقات البيانات: الخطوط الأول ثم النقاط (عشان النقاط تبان فوق الخطوط)
  function drawData() {
    var all = null, pi = 0;
    state.dataLayers.forEach(function (d) {
      var big = d.features.length > BIG_LAYER;
      var color = d.kind === 'line' ? NET_COLOR[state.summary.network] : POINT_COLORS[pi++ % POINT_COLORS.length];
      var group = lazyGroup(function (grp) {
        L.geoJSON({ type: 'FeatureCollection', features: d.features }, {
          style: function () { return { color: color, weight: d.role === 'mainline' ? 3 : 2, opacity: 0.85 }; },
          pointToLayer: function (f, ll) {
            return L.circleMarker(ll, { radius: 4, color: '#ffffff', weight: 1, fillColor: color, fillOpacity: 0.95 });
          },
          onEachFeature: function (f, l) { l.bindPopup(function () { return dataPopup(d.fc, f.properties); }); }
        }).addTo(grp);
      });
      addOverlay(group, d.fc + ' (' + d.features.length + ')' + (big ? ' — كبيرة، فعّلها يدويًا' : ''), !big);
      var bb = geomBounds(d.features);
      if (bb) all = all ? all.extend(bb) : bb;
    });
    state.bounds = all;
  }

  // طبقة الأخطاء (بالأحمر فوق كل البيانات)، ممكن تتفلتر بنوع خطأ
  function drawErrors(type) {
    if (errOverlay) removeOverlay(errOverlay);
    var feats = state.features.filter(function (f) { return !type || f.properties.types.indexOf(type) >= 0; });
    errOverlay = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
      style: function () { return { color: '#c41e3a', weight: 5, opacity: 0.95 }; },
      onEachFeature: function (f, l) {
        l.bindPopup(function () {
          var box = el('div');
          box.append(el('b', { textContent: f.properties.fc + ' — OID ' + f.properties.oid }));
          var ul = el('ul');
          f.properties.types.forEach(function (t) { ul.append(el('li', { textContent: t })); });
          box.append(ul);
          return box;
        });
      }
    });
    addOverlay(errOverlay, 'الأخطاء (' + feats.length + ')' + (type ? ' — مفلترة' : ''), true);
    errOverlay.bringToFront();
    if (type && feats.length) map.fitBounds(errOverlay.getBounds().pad(0.2), { maxZoom: 19 });
  }

  // ------------------------------------------------------------ التشغيل
  async function runCheck() {
    hideErr();
    $('go').disabled = true;
    $('prog-sec').hidden = false;
    setProgress(0.02, 'جاري تجهيز المحرك...');
    try {
      var g = await loadEngine();
      setProgress(0.04, 'جاري فتح الملف...');
      var ds = await Reader.openDataset(g, chosen);
      var rd = await Reader.readForQA(g, ds, network, setProgress);
      setProgress(0.55, 'جاري الفحص...');
      var result = await QA.run(rd.input, setProgress);
      rd.input = null;                       // تحرير الذاكرة
      var summary = QA.buildSummary(result);
      summary.warnings = rd.warnings;

      // كل طبقات البيانات بإحداثيات WGS84 (للخريطة): الخطوط الأول ثم النقاط
      var metas = rd.layerMeta.slice().sort(function (x, y) { return (x.kind === 'line' ? 0 : 1) - (y.kind === 'line' ? 0 : 1); });
      var dataLayers = [], lineGeoms = {};
      for (var i = 0; i < metas.length; i++) {
        setProgress(0.9 + 0.09 * i / metas.length, 'جاري تجهيز الخريطة: ' + metas[i].fc);
        var feats0 = await Reader.readLayerWgs84(g, ds, metas[i].fc, metas[i].fields);
        dataLayers.push({ fc: metas[i].fc, kind: metas[i].kind, role: metas[i].role, features: feats0 });
        if (metas[i].kind === 'line') {
          var mp = new Map();
          feats0.forEach(function (f) { mp.set(f.properties.__OID__, f.geometry); });
          lineGeoms[metas[i].fc] = mp;
        }
      }
      var groups = new Map();
      result.errors.forEach(function (e) {
        var k = e.fc + '\u0000' + e.oid, cur = groups.get(k);
        if (!cur) { cur = { fc: e.fc, oid: e.oid, types: [], count: 0 }; groups.set(k, cur); }
        cur.count++;
        if (cur.types.indexOf(e.type) < 0) cur.types.push(e.type);
      });
      var features = [], noGeom = 0;
      groups.forEach(function (gp) {
        var geom = lineGeoms[gp.fc] && lineGeoms[gp.fc].get(gp.oid);
        if (geom) features.push({ type: 'Feature', properties: gp, geometry: geom }); else noGeom++;
      });
      if (noGeom) summary.warnings = (summary.warnings || []).concat(noGeom + ' خط فيه أخطاء مقدرتش أرسمه على الخريطة (هندسته فاضية أو تالفة). هتلاقيه في التقارير.');
      try { await g.close(ds); } catch (e) { /* تجاهل */ }

      state = { result: result, summary: summary, features: features, dataLayers: dataLayers, bounds: null, crsWkt: rd.crsWkt, exportsCache: {} };
      showResult();
    } catch (e) {
      if (!(e && e.userMessage)) console.error(e);
      showErr(e && e.userMessage ? e.userMessage : 'حصل خطأ غير متوقع أثناء الفحص. جرّب ملف أصغر أو متصفح تاني.');
      $('prog-sec').hidden = true;
      $('go').disabled = !chosen;
    }
  }

  // ------------------------------------------------------------ عرض النتيجة
  function showResult() {
    var s = state.summary, total = s.total_errors;
    $('form-sec').hidden = true; $('prog-sec').hidden = true; $('res-sec').hidden = false;
    var checked = Object.keys(s.lines_checked).reduce(function (a, k) { return a + s.lines_checked[k]; }, 0);
    var v = $('verdict');
    v.className = 'verdict ' + (total ? 'bad' : 'ok');
    v.textContent = total ? total + ' خطأ في ' + s.lines_with_errors + ' خط' : 'مفيش أخطاء. البيانات اجتازت كل الفحوصات.';
    $('meta').textContent = 'تم فحص ' + checked + ' خط مقابل ' + s.points_indexed + ' نقطة.';

    var w = $('warns'); w.replaceChildren();
    (s.warnings || []).forEach(function (t) { w.append(el('div', { className: 'warn', textContent: t })); });

    var tb = $('types'); tb.replaceChildren();
    s.by_type.forEach(function (t) {
      var tr = el('tr', { className: 'row', tabIndex: 0 });
      tr.append(el('td', null, el('span', { className: 'cat', textContent: t.category === 'Geometric' ? 'هندسي' : 'بيانات' }), t.type),
                el('td', { className: 'n', textContent: t.count }));
      var pick = function () { filterType(t.type, tr); };
      tr.addEventListener('click', pick);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') pick(); });
      tb.append(tr);
    });

    var dls = $('dls'); dls.replaceChildren();
    if (total) {
      dls.append(dlButton('CSV', 'csv'), dlButton('GeoPackage', 'gpkg'), dlButton('Shapefile', 'shp'));
    }
    selType = null; $('showall').hidden = true;
    clearOverlays();
    drawData();
    drawErrors(null);
    $('mapempty').hidden = true;
    if (state.bounds) map.fitBounds(state.bounds.pad(0.1), { maxZoom: 19 });
    layersControl.expand();
  }

  function filterType(type, row) {
    var same = selType === type;
    selType = same ? null : type;
    document.querySelectorAll('tr.row').forEach(function (r) { r.classList.remove('sel'); });
    if (!same) row.classList.add('sel');
    $('showall').hidden = same;
    drawErrors(selType);
    if (same && state.bounds) map.fitBounds(state.bounds.pad(0.1), { maxZoom: 19 });
  }

  // ------------------------------------------------------------ التصدير
  function download(blob, name) {
    var a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function strip2D(g) {   // شيل المنسوب Z زي النسخة الأصلية (force_2d)
    var f = function (c) { return typeof c[0] === 'number' ? [c[0], c[1]] : c.map(f); };
    return { type: g.type, coordinates: f(g.coordinates) };
  }

  function nativeErrorsGeoJSON() {
    var feats = [];
    state.result.errors.forEach(function (e) {
      if (!e.geom) return;
      feats.push({ type: 'Feature', geometry: strip2D(e.geom), properties: {
        FC_NAME: e.fc, ORIG_OID: e.oid, ERR_CAT: e.category,
        ERR_TYPE: e.type.slice(0, 150), DETAILS: e.details.slice(0, 254) } });
    });
    return { type: 'FeatureCollection', features: feats };
  }


  // ---- ZIP بسيط (بدون ضغط) لتجميع ملفات الـ Shapefile
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function makeZip(files) {   // files: [{name, data: Uint8Array}]
    var enc = new TextEncoder(), parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, size, true);
      lh.setUint32(22, size, true); lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, f.data);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true);
      ch.setUint32(24, size, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + size;
    });
    var cdSize = central.reduce(function (s, a) { return s + a.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }

  async function exportGdal(kind) {
    var g = await loadEngine();
    var json = JSON.stringify(nativeErrorsGeoJSON());
    var src = await g.open(new File([json], 'errors_native.geojson', { type: 'application/geo+json' }));
    var ds = src.datasets[0];
    var opts = kind === 'gpkg' ? ['-f', 'GPKG', '-nln', 'errors'] : ['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8'];
    if (state.crsWkt) opts.push('-a_srs', state.crsWkt);
    var out = await g.ogr2ogr(ds, opts, kind === 'gpkg' ? 'QA_errors.gpkg' : 'ERROR_LINES');
    var blob;
    if (kind === 'gpkg') {
      blob = new Blob([await g.getFileBytes(out)], { type: 'application/geopackage+sqlite3' });
    } else {   // الـ Shapefile عبارة عن عدة ملفات: نجمّعها في ZIP
      var files = [];
      for (var i = 0; i < out.all.length; i++) {
        var item = out.all[i];
        var base = item.real.split('/').pop().replace(/^ERROR_LINES(\.shp)?\./, 'ERROR_LINES.');
        files.push({ name: base, data: await g.getFileBytes(item) });
      }
      blob = makeZip(files);
    }
    try { await g.close(out); await g.close(ds); } catch (e) { /* تجاهل */ }
    return blob;
  }

  function dlButton(label, kind) {
    var b = el('button', { className: 'dl', textContent: label });
    b.addEventListener('click', async function () {
      var cache = state.exportsCache;
      var names = { csv: 'QA_errors.csv', gpkg: 'QA_errors.gpkg', shp: 'QA_errors_shp.zip' };
      b.disabled = true; var old = b.textContent; b.textContent = 'جاري التجهيز...';
      try {
        if (!cache[kind]) {
          cache[kind] = kind === 'csv'
            ? new Blob([QA.toCSV(state.result.errors)], { type: 'text/csv;charset=utf-8' })
            : await exportGdal(kind);
        }
        download(cache[kind], names[kind]);
      } catch (e) {
        console.error(e);
        showErr('تعذر تجهيز ملف ' + label + '. جرّب CSV أو حدّث الصفحة.');
      } finally { b.disabled = false; b.textContent = old; }
    });
    return b;
  }


  // ------------------------------------------------------------ كارت التواصل
  function chatIcon() {
    var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '18'); svg.setAttribute('height', '18'); svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
    svg.append(path);
    return svg;
  }

  function renderContact(p) {
    var box = $('contact');
    if (!p || !String(p.name || '').trim()) return;          // من غير اسم: الكارت متخفّي
    var name = String(p.name).trim();
    var av = null;
    if (p.photo) {                                          // الصورة اختيارية
      av = el('img', { className: 'avatar', src: p.photo, alt: name });
      av.addEventListener('error', function () { av.remove(); });   // الصورة مش موجودة: نشيلها
    }
    var who = el('div', { className: 'who' },
      el('div', null, el('div', { className: 'nm', textContent: name }), el('div', { className: 'tt', textContent: p.title || '' })));
    if (av) who.prepend(av);
    box.append(who);

    var num = String(p.whatsapp || '').replace(/\D/g, '').replace(/^00/, '');
    if (num) {
      var href = 'https://wa.me/' + num + (p.message ? '?text=' + encodeURIComponent(p.message) : '');
      var a = el('a', { className: 'wa', href: href, target: '_blank', rel: 'noopener' });
      a.append(chatIcon(), document.createTextNode('تواصل معي على واتساب'));
      box.append(a);
    }
    box.hidden = false;
  }

  // ------------------------------------------------------------ ربط الواجهة
  function setFile(f) {
    if (!f) return;
    chosen = f;
    $('fname').textContent = f.name;
    $('fhint').textContent = (f.size / 1048576).toFixed(1) + ' MB';
    $('go').disabled = false;
    hideErr();
  }

  function init() {
    initMap();
    renderContact(window.PROFILE);
    Object.keys(QA.NETWORKS).forEach(function (key, i) {
      var n = QA.NETWORKS[key];
      var lab = el('label', { className: 'net' });
      lab.dataset.net = key;
      var inp = el('input', { type: 'radio', name: 'net', value: key, checked: i === 0 });
      inp.addEventListener('change', function () { network = key; });
      lab.append(inp, el('b', { textContent: n.label.replace('شبكة ', '') }),
                 el('small', { textContent: n.mainline + ' · ' + n.lateral }));
      $('networks').append(lab);
    });

    var drop = $('drop'), input = $('file');
    drop.addEventListener('click', function () { input.click(); });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { setFile(e.dataTransfer.files[0]); });
    input.addEventListener('change', function () { setFile(input.files[0]); });
    $('go').addEventListener('click', runCheck);

    $('showall').addEventListener('click', function () {
      selType = null; $('showall').hidden = true;
      document.querySelectorAll('tr.row').forEach(function (r) { r.classList.remove('sel'); });
      drawErrors(null);
      if (state.bounds) map.fitBounds(state.bounds.pad(0.1), { maxZoom: 19 });
    });
    $('again').addEventListener('click', function () {
      $('res-sec').hidden = true; $('form-sec').hidden = false;
      chosen = null; input.value = ''; $('go').disabled = true; state = null;
      $('fname').textContent = 'اسحب الملف هنا أو اضغط للاختيار';
      $('fhint').textContent = 'ملف ZIP فيه الـ Geodatabase، أو ملف GeoPackage';
      clearOverlays();
      $('mapempty').hidden = false;
      $('mapempty').querySelector('span').textContent = 'الخريطة هتظهر هنا بعد الفحص';
    });

    if (/[?&]debug\b/.test(location.search)) window.__qa = { map: map, state: function () { return state; } };
    loadEngine();   // ابدأ تحميل المحرك في الخلفية من أول ما الصفحة تفتح
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
